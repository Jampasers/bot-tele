import { Schema, type Document, type Query, type PipelineStage } from "mongoose";
import { getTenantId } from "./context.js";

export interface TenantPluginOptions { singleton?: boolean }
type TenantDocument = Document & { tenantId?: string; $where?: Record<string, unknown> };

export function scopeTenantFilter(filter: Record<string, unknown>, tenantId = getTenantId()): Record<string, unknown> {
  if (Object.hasOwn(filter, "tenantId") && filter.tenantId !== tenantId) {
    throw new Error("Cross-tenant query rejected");
  }
  return { $and: [filter, { tenantId }] };
}

function assertTenantPaths(update: Record<string, unknown>, tenantId: string): void {
  for (const [operator, value] of Object.entries(update)) {
    const paths = operator.startsWith("$") && value && typeof value === "object"
      ? Object.entries(value as Record<string, unknown>) : [[operator, value]];
    for (const [path, operand] of paths) {
      if (typeof path === "string" && (path === "tenantId" || path.startsWith("tenantId."))) {
        if (operator !== "$setOnInsert" || path !== "tenantId" || operand !== tenantId) {
          throw new Error("Tenant identity cannot be modified");
        }
      }
      if (operator === "$rename" && typeof operand === "string" && (operand === "tenantId" || operand.startsWith("tenantId."))) {
        throw new Error("Tenant identity cannot be modified");
      }
    }
  }
}

export function scopeTenantUpdate(update: unknown, replacement = false, tenantId = getTenantId()): Record<string, unknown> {
  if (!update || typeof update !== "object" || Array.isArray(update)) {
    throw new Error("Tenant updates require an object; update pipelines are not supported");
  }
  const value = update as Record<string, unknown>;
  if (replacement) {
    if (Object.hasOwn(value, "tenantId") && value.tenantId !== tenantId) throw new Error("Cross-tenant replacement rejected");
    return { ...value, tenantId };
  }
  assertTenantPaths(value, tenantId);
  return { ...value, $setOnInsert: { ...(value.$setOnInsert as Record<string, unknown> | undefined), tenantId } };
}

// Only transformations of the current scoped stream are allowed. Unknown/new stages
// fail closed, including stages that open other collections or nested input pipelines.
const allowedStages = new Set(["$addFields", "$bucket", "$bucketAuto", "$count", "$densify", "$facet", "$fill", "$group", "$limit", "$match", "$project", "$redact", "$replaceRoot", "$replaceWith", "$sample", "$set", "$setWindowFields", "$skip", "$sort", "$sortByCount", "$unset", "$unwind"]);

export function scopeTenantPipeline(pipeline: PipelineStage[], tenantId = getTenantId()): void {
  function inspect(stages: unknown[]): void {
    for (const stage of stages) {
      if (!stage || typeof stage !== "object") throw new Error("Invalid aggregate stage");
      for (const [key, value] of Object.entries(stage)) {
        if (!allowedStages.has(key)) throw new Error(`Unsafe tenant aggregate stage: ${key}`);
        if (key === "$facet" && value && typeof value === "object") {
          for (const nested of Object.values(value)) if (Array.isArray(nested)) inspect(nested);
        }
      }
    }
  }
  inspect(pipeline);
  pipeline.unshift({ $match: { tenantId } });
}

function stampDocument(doc: TenantDocument): void {
  const tenantId = getTenantId();
  if (doc.tenantId !== undefined && doc.tenantId !== tenantId) throw new Error("Cross-tenant document rejected");
  if (!doc.isNew && doc.tenantId === undefined) throw new Error("Legacy document requires tenant migration before writing");
  doc.set("tenantId", tenantId);
  doc.$where = { ...doc.$where, tenantId };
}

/** Applied explicitly before model compilation. Raw Mongo collections are migration-only. */
export function tenantPlugin(schema: Schema, options: TenantPluginOptions = {}): void {
  const existingIndexes = schema.indexes();
  function clearDeclaredIndexes(target: Schema): void {
    target.clearIndexes();
    target.eachPath((_name, path) => { path.index(false); });
    for (const child of target.childSchemas) clearDeclaredIndexes(child.schema);
  }
  clearDeclaredIndexes(schema);
  schema.add({ tenantId: { type: String, required: true, immutable: true, default: getTenantId } });
  schema.index({ tenantId: 1 }, options.singleton ? { unique: true } : {});
  for (const [keys, indexOptions] of existingIndexes) {
    // TTL indexes cannot be compound and do not make rows visible to another tenant.
    const scopedKeys = indexOptions.expireAfterSeconds !== undefined ? keys : { tenantId: 1 as const, ...keys };
    const { name: _oldName, ...retainedOptions } = indexOptions;
    // A compound sparse index containing required tenantId would include every row.
    // Preserve the original sparse inclusion rule with a partial index instead.
    if (retainedOptions.sparse && indexOptions.expireAfterSeconds === undefined) {
      delete retainedOptions.sparse;
      if (retainedOptions.partialFilterExpression) throw new Error("Sparse and partial tenant indexes cannot be combined");
      const fields = Object.keys(keys).filter(key => key !== "tenantId");
      if (fields.length) retainedOptions.partialFilterExpression = {
        $or: fields.map(key => ({ [key]: { $exists: true } })),
      };
    }
    schema.index(scopedKeys, retainedOptions);
  }
  // Changes to persistent indexes are made by the reviewed migration command only.
  schema.set("autoIndex", false);

  schema.pre(["find", "findOne", "countDocuments", "distinct", "updateOne", "updateMany", "findOneAndUpdate", "findOneAndReplace", "replaceOne", "deleteOne", "deleteMany", "findOneAndDelete"], function(this: Query<unknown, unknown>) {
    const tenantId = getTenantId();
    this.setQuery(scopeTenantFilter(this.getFilter(), tenantId));
    const update = this.getUpdate();
    const op = (this as unknown as { op: string }).op;
    if (update) this.setUpdate(scopeTenantUpdate(update, op === "replaceOne" || op === "findOneAndReplace", tenantId));
  });
  schema.pre("validate", function() { stampDocument(this as TenantDocument); });
  schema.pre("save", function() { stampDocument(this as TenantDocument); });
  schema.pre("updateOne", { document: true, query: false }, function() { stampDocument(this as TenantDocument); });
  schema.pre("deleteOne", { document: true, query: false }, function() {
    stampDocument(this as TenantDocument);
    // Document.deleteOne does not consistently use query middleware or $where.
    throw new Error("Use Model.deleteOne with a scoped filter for tenant documents");
  });
  schema.pre("insertMany", function(docs: unknown) {
    const tenantId = getTenantId();
    for (const doc of Array.isArray(docs) ? docs : [docs]) {
      if (!doc || typeof doc !== "object") throw new Error("Invalid tenant document");
      const value = doc as Record<string, unknown>;
      if (value.tenantId !== undefined && value.tenantId !== tenantId) throw new Error("Cross-tenant insert rejected");
      value.tenantId = tenantId;
    }
  });
  schema.pre("aggregate", function() { scopeTenantPipeline(this.pipeline()); });
  schema.pre("estimatedDocumentCount", function() { throw new Error("Use countDocuments for tenant-scoped counts"); });
  schema.pre("bulkWrite", function() { throw new Error("bulkWrite is not enabled for tenant models; use scoped model operations"); });
}
