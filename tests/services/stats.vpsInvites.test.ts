import assert from "node:assert/strict";
import test from "node:test";
import { BotStatsService } from "../../src/services/stats.js";
import { VpsOrder } from "../../src/models/VpsOrder.js";
import { User } from "../../src/models/User.js";
import { Order } from "../../src/models/Order.js";
import { DigitalOrder } from "../../src/models/DigitalOrder.js";
import { DigitalProduct } from "../../src/models/DigitalProduct.js";
import { DigitalStock } from "../../src/models/DigitalStock.js";
import { TopupSession } from "../../src/models/TopupSession.js";
import { platformContext, runWithTenant } from "../../src/tenant/context.js";

// Evaluate the small Mongo aggregation subset used by revenue queries, against
// mixed historical/paid/free/closed orders rather than a canned aggregate value.
type Row = Record<string, any>;
function value(expr: any, row: Row): any {
  if (typeof expr === "string" && expr.startsWith("$")) return expr.slice(1).split(".").reduce((part, key) => part?.[key], row);
  if (expr?.$eq) return value(expr.$eq[0], row) === value(expr.$eq[1], row);
  if (expr?.$cond) return value(expr.$cond[value(expr.$cond[0], row) ? 1 : 2], row);
  return expr;
}
function aggregate(rows: Row[], pipeline: Row[]): Row[] {
  let selected = rows;
  for (const stage of pipeline) {
    if (stage.$match) selected = selected.filter(row => Object.entries(stage.$match).every(([key, expected]: [string, any]) => {
      const actual = row[key];
      if (expected && typeof expected === "object") return (expected.$gte === undefined || actual >= expected.$gte) && (expected.$lt === undefined || actual < expected.$lt);
      return actual === expected;
    }));
    if (stage.$group) return [Object.fromEntries(Object.entries(stage.$group).filter(([key]) => key !== "_id")
      .map(([key, expr]: [string, any]) => [key, selected.reduce((sum, row) => sum + (value(expr.$sum, row) ?? 0), 0)]))];
  }
  throw new Error("Expected a revenue group");
}

test("free installations count as orders but add no revenue in period and overview reports", async t => {
  const createdAt = new Date();
  const row = (price: number, paymentMethod?: string, paymentStatus = "paid", tenantId = "platform") => ({ createdAt, snapshot: { price }, paymentMethod, paymentStatus, tenantId });
  const rows = [row(10000, "balance"), row(5000), row(8000, "qris"), row(100000, "invite"), row(20000, "balance", "unpaid"), row(80000, "invite", "refunded"), row(10000, "balance", "paid", "rental")];
  t.mock.method(VpsOrder, "aggregate", (async (pipeline: Row[]) => aggregate(rows, pipeline)) as never);
  for (const model of [User, Order, DigitalOrder, TopupSession]) t.mock.method(model, "aggregate", (async () => []) as never);
  for (const model of [User, Order, DigitalProduct, DigitalStock]) t.mock.method(model, "countDocuments", (async () => 0) as never);
  await runWithTenant(platformContext(), async () => {
    const period = await BotStatsService.getRevenueStats("today", undefined, new Date(createdAt.getTime() + 1));
    assert.equal(period.vpsRevenue, 23000); assert.equal(period.vpsOrders, 4);
    assert.equal(period.totalRevenue, 23000);
    const overview = await BotStatsService.getOverviewStats();
    assert.equal(overview.vpsTotalRevenue, 23000); assert.equal(overview.vpsTodayRevenue, 23000);
    assert.equal(overview.vpsTotalOrders, 4); assert.equal(overview.vpsTodayOrders, 4);
  });
});
