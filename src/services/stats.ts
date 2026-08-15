import { User } from "../models/User.js";
import { Order } from "../models/Order.js";
import { DigitalOrder } from "../models/DigitalOrder.js";
import { DigitalProduct } from "../models/DigitalProduct.js";
import { DigitalStock } from "../models/DigitalStock.js";
import { TopupSession } from "../models/TopupSession.js";

// ============================================================================
//  Types & Interfaces for Statistics
// ============================================================================

export interface OverviewStats {
  totalUsers: number;
  newUsersToday: number;
  totalUserBalance: number;

  // Finance / QRIS
  qrisTotalSettledAmount: number;
  qrisTotalSettledCount: number;
  qrisTodaySettledAmount: number;
  qrisTodaySettledCount: number;

  // Digital Products
  digitalTotalRevenue: number;
  digitalTotalOrders: number;
  digitalTodayRevenue: number;
  digitalTodayOrders: number;

  // SMS OTP
  smsTotalRevenue: number;
  smsTotalOrders: number;
  smsCompletedOrders: number;
  smsTodayRevenue: number;
  smsTodayCompletedCount: number;

  // Catalog
  totalDigitalProducts: number;
  totalStockAvailable: number;
}

export interface UserStats {
  totalUsers: number;
  newToday: number;
  newThisWeek: number;
  newThisMonth: number;
  usersWithBalanceCount: number;
  totalBalance: number;
  avgBalance: number;
  topBalances: Array<{
    telegramId: string;
    firstName: string;
    username?: string | undefined;
    balance: number;
  }>;
  topActiveUsers: Array<{
    telegramId: string;
    firstName: string;
    username?: string | undefined;
    totalOrders: number;
    balance: number;
  }>;
}

export interface FinanceStats {
  totalSettledAmount: number;
  totalSettledCount: number;
  todaySettledAmount: number;
  todaySettledCount: number;
  weekSettledAmount: number;
  weekSettledCount: number;
  monthSettledAmount: number;
  monthSettledCount: number;
  pendingCount: number;
  expiredOrCancelledCount: number;
  conversionRate: number;
}

export interface DigitalStats {
  totalRevenue: number;
  totalOrders: number;
  totalItemsSold: number;
  todayRevenue: number;
  todayOrders: number;
  monthRevenue: number;
  monthOrders: number;
  totalProducts: number;
  activeProducts: number;
  totalCategories: number;
  totalStockAvailable: number;
  totalStockSold: number;
  topSellingProducts: Array<{
    productName: string;
    totalSold: number;
    totalRevenue: number;
  }>;
}

export interface SmsStats {
  totalOrders: number;
  completedOrders: number;
  canceledOrders: number;
  pendingOrders: number;
  successRate: number;
  totalCost: number;
  todayCost: number;
  todayCompletedCount: number;
  monthCost: number;
  monthCompletedCount: number;
  topServices: Array<{
    service: string;
    count: number;
    totalCost: number;
  }>;
  topCountries: Array<{
    country: number;
    count: number;
  }>;
}

// ============================================================================
//  Date Boundary Utilities
// ============================================================================

export function getStartOfDay(): Date {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now;
}

export function getStartOfWeek(): Date {
  const now = new Date();
  const day = now.getDay();
  const diff = now.getDate() - day + (day === 0 ? -6 : 1);
  const start = new Date(now.setDate(diff));
  start.setHours(0, 0, 0, 0);
  return start;
}

export function getStartOfMonth(): Date {
  const now = new Date();
  now.setDate(1);
  now.setHours(0, 0, 0, 0);
  return now;
}

// ============================================================================
//  Bot Stats Service
// ============================================================================

export class BotStatsService {
  /**
   * Returns top-level aggregated overview metrics for the entire bot.
   */
  static async getOverviewStats(): Promise<OverviewStats> {
    const startOfDay = getStartOfDay();

    // 1. Users
    const [totalUsers, newUsersToday, balanceRes] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ createdAt: { $gte: startOfDay } }),
      User.aggregate<{ total: number }>([
        { $group: { _id: null, total: { $sum: "$balance" } } },
      ]),
    ]);
    const totalUserBalance = balanceRes[0]?.total ?? 0;

    // 2. Finance / QRIS Deposits
    const [qrisAllRes, qrisTodayRes] = await Promise.all([
      TopupSession.aggregate<{ totalAmount: number; totalCount: number }>([
        { $match: { status: "SETTLED" } },
        {
          $group: {
            _id: null,
            totalAmount: { $sum: "$amountIDR" },
            totalCount: { $sum: 1 },
          },
        },
      ]),
      TopupSession.aggregate<{ totalAmount: number; totalCount: number }>([
        { $match: { status: "SETTLED", createdAt: { $gte: startOfDay } } },
        {
          $group: {
            _id: null,
            totalAmount: { $sum: "$amountIDR" },
            totalCount: { $sum: 1 },
          },
        },
      ]),
    ]);
    const qrisTotalSettledAmount = qrisAllRes[0]?.totalAmount ?? 0;
    const qrisTotalSettledCount = qrisAllRes[0]?.totalCount ?? 0;
    const qrisTodaySettledAmount = qrisTodayRes[0]?.totalAmount ?? 0;
    const qrisTodaySettledCount = qrisTodayRes[0]?.totalCount ?? 0;

    // 3. Digital Products
    const [digiAllRes, digiTodayRes, totalDigitalProducts, totalStockAvailable] =
      await Promise.all([
        DigitalOrder.aggregate<{ totalRev: number; count: number }>([
          {
            $group: {
              _id: null,
              totalRev: { $sum: "$price" },
              count: { $sum: 1 },
            },
          },
        ]),
        DigitalOrder.aggregate<{ totalRev: number; count: number }>([
          { $match: { createdAt: { $gte: startOfDay } } },
          {
            $group: {
              _id: null,
              totalRev: { $sum: "$price" },
              count: { $sum: 1 },
            },
          },
        ]),
        DigitalProduct.countDocuments(),
        DigitalStock.countDocuments({ isSold: false }),
      ]);
    const digitalTotalRevenue = digiAllRes[0]?.totalRev ?? 0;
    const digitalTotalOrders = digiAllRes[0]?.count ?? 0;
    const digitalTodayRevenue = digiTodayRes[0]?.totalRev ?? 0;
    const digitalTodayOrders = digiTodayRes[0]?.count ?? 0;

    // 4. SMS OTP
    const [smsTotalOrders, smsCompletedOrders, smsAllCostRes, smsTodayRes] =
      await Promise.all([
        Order.countDocuments(),
        Order.countDocuments({ status: "COMPLETED" }),
        Order.aggregate<{ totalCost: number }>([
          { $match: { status: "COMPLETED" } },
          { $group: { _id: null, totalCost: { $sum: "$cost" } } },
        ]),
        Order.aggregate<{ totalCost: number; count: number }>([
          { $match: { status: "COMPLETED", createdAt: { $gte: startOfDay } } },
          {
            $group: {
              _id: null,
              totalCost: { $sum: "$cost" },
              count: { $sum: 1 },
            },
          },
        ]),
      ]);
    const smsTotalRevenue = smsAllCostRes[0]?.totalCost ?? 0;
    const smsTodayRevenue = smsTodayRes[0]?.totalCost ?? 0;
    const smsTodayCompletedCount = smsTodayRes[0]?.count ?? 0;

    return {
      totalUsers,
      newUsersToday,
      totalUserBalance,
      qrisTotalSettledAmount,
      qrisTotalSettledCount,
      qrisTodaySettledAmount,
      qrisTodaySettledCount,
      digitalTotalRevenue,
      digitalTotalOrders,
      digitalTodayRevenue,
      digitalTodayOrders,
      smsTotalRevenue,
      smsTotalOrders,
      smsCompletedOrders,
      smsTodayRevenue,
      smsTodayCompletedCount,
      totalDigitalProducts,
      totalStockAvailable,
    };
  }

  /**
   * Detailed statistics about bot users.
   */
  static async getUserStats(): Promise<UserStats> {
    const startOfDay = getStartOfDay();
    const startOfWeek = getStartOfWeek();
    const startOfMonth = getStartOfMonth();

    const [
      totalUsers,
      newToday,
      newThisWeek,
      newThisMonth,
      usersWithBalanceCount,
      balanceRes,
      topBalancesRaw,
      topActiveRaw,
    ] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ createdAt: { $gte: startOfDay } }),
      User.countDocuments({ createdAt: { $gte: startOfWeek } }),
      User.countDocuments({ createdAt: { $gte: startOfMonth } }),
      User.countDocuments({ balance: { $gt: 0 } }),
      User.aggregate<{ total: number }>([
        { $group: { _id: null, total: { $sum: "$balance" } } },
      ]),
      User.find({ balance: { $gt: 0 } })
        .sort({ balance: -1 })
        .limit(5)
        .lean(),
      User.find({ totalOrders: { $gt: 0 } })
        .sort({ totalOrders: -1 })
        .limit(5)
        .lean(),
    ]);

    const totalBalance = balanceRes[0]?.total ?? 0;
    const avgBalance =
      usersWithBalanceCount > 0
        ? Math.round(totalBalance / usersWithBalanceCount)
        : 0;

    const topBalances = topBalancesRaw.map((u) => ({
      telegramId: u.telegramId,
      firstName: u.firstName,
      username: u.username,
      balance: u.balance,
    }));

    const topActiveUsers = topActiveRaw.map((u) => ({
      telegramId: u.telegramId,
      firstName: u.firstName,
      username: u.username,
      totalOrders: u.totalOrders,
      balance: u.balance,
    }));

    return {
      totalUsers,
      newToday,
      newThisWeek,
      newThisMonth,
      usersWithBalanceCount,
      totalBalance,
      avgBalance,
      topBalances,
      topActiveUsers,
    };
  }

  /**
   * Detailed financial and QRIS top-up statistics.
   */
  static async getFinanceStats(): Promise<FinanceStats> {
    const startOfDay = getStartOfDay();
    const startOfWeek = getStartOfWeek();
    const startOfMonth = getStartOfMonth();

    const [
      allSettledRes,
      todaySettledRes,
      weekSettledRes,
      monthSettledRes,
      pendingCount,
      expiredOrCancelledCount,
      totalSessions,
    ] = await Promise.all([
      TopupSession.aggregate<{ totalAmount: number; totalCount: number }>([
        { $match: { status: "SETTLED" } },
        {
          $group: {
            _id: null,
            totalAmount: { $sum: "$amountIDR" },
            totalCount: { $sum: 1 },
          },
        },
      ]),
      TopupSession.aggregate<{ totalAmount: number; totalCount: number }>([
        { $match: { status: "SETTLED", createdAt: { $gte: startOfDay } } },
        {
          $group: {
            _id: null,
            totalAmount: { $sum: "$amountIDR" },
            totalCount: { $sum: 1 },
          },
        },
      ]),
      TopupSession.aggregate<{ totalAmount: number; totalCount: number }>([
        { $match: { status: "SETTLED", createdAt: { $gte: startOfWeek } } },
        {
          $group: {
            _id: null,
            totalAmount: { $sum: "$amountIDR" },
            totalCount: { $sum: 1 },
          },
        },
      ]),
      TopupSession.aggregate<{ totalAmount: number; totalCount: number }>([
        { $match: { status: "SETTLED", createdAt: { $gte: startOfMonth } } },
        {
          $group: {
            _id: null,
            totalAmount: { $sum: "$amountIDR" },
            totalCount: { $sum: 1 },
          },
        },
      ]),
      TopupSession.countDocuments({ status: "PENDING" }),
      TopupSession.countDocuments({
        status: { $in: ["EXPIRED", "CANCELLED"] },
      }),
      TopupSession.countDocuments(),
    ]);

    const totalSettledAmount = allSettledRes[0]?.totalAmount ?? 0;
    const totalSettledCount = allSettledRes[0]?.totalCount ?? 0;
    const todaySettledAmount = todaySettledRes[0]?.totalAmount ?? 0;
    const todaySettledCount = todaySettledRes[0]?.totalCount ?? 0;
    const weekSettledAmount = weekSettledRes[0]?.totalAmount ?? 0;
    const weekSettledCount = weekSettledRes[0]?.totalCount ?? 0;
    const monthSettledAmount = monthSettledRes[0]?.totalAmount ?? 0;
    const monthSettledCount = monthSettledRes[0]?.totalCount ?? 0;

    const conversionRate =
      totalSessions > 0
        ? Math.round((totalSettledCount / totalSessions) * 1000) / 10
        : 0;

    return {
      totalSettledAmount,
      totalSettledCount,
      todaySettledAmount,
      todaySettledCount,
      weekSettledAmount,
      weekSettledCount,
      monthSettledAmount,
      monthSettledCount,
      pendingCount,
      expiredOrCancelledCount,
      conversionRate,
    };
  }

  /**
   * Detailed digital store and catalog sales statistics.
   */
  static async getDigitalStats(): Promise<DigitalStats> {
    const startOfDay = getStartOfDay();
    const startOfMonth = getStartOfMonth();

    const [
      allOrdersRes,
      todayOrdersRes,
      monthOrdersRes,
      totalProducts,
      activeProducts,
      categories,
      totalStockAvailable,
      totalStockSold,
      topSellingRaw,
    ] = await Promise.all([
      DigitalOrder.aggregate<{
        totalRev: number;
        totalOrders: number;
        totalItems: number;
      }>([
        {
          $group: {
            _id: null,
            totalRev: { $sum: "$price" },
            totalOrders: { $sum: 1 },
            totalItems: { $sum: "$quantity" },
          },
        },
      ]),
      DigitalOrder.aggregate<{ totalRev: number; totalOrders: number }>([
        { $match: { createdAt: { $gte: startOfDay } } },
        {
          $group: {
            _id: null,
            totalRev: { $sum: "$price" },
            totalOrders: { $sum: 1 },
          },
        },
      ]),
      DigitalOrder.aggregate<{ totalRev: number; totalOrders: number }>([
        { $match: { createdAt: { $gte: startOfMonth } } },
        {
          $group: {
            _id: null,
            totalRev: { $sum: "$price" },
            totalOrders: { $sum: 1 },
          },
        },
      ]),
      DigitalProduct.countDocuments(),
      DigitalProduct.countDocuments({ isActive: true }),
      DigitalProduct.distinct("category"),
      DigitalStock.countDocuments({ isSold: false }),
      DigitalStock.countDocuments({ isSold: true }),
      DigitalOrder.aggregate<{
        _id: string;
        totalSold: number;
        totalRevenue: number;
      }>([
        {
          $group: {
            _id: "$productName",
            totalSold: { $sum: "$quantity" },
            totalRevenue: { $sum: "$price" },
          },
        },
        { $sort: { totalSold: -1 } },
        { $limit: 5 },
      ]),
    ]);

    const totalRevenue = allOrdersRes[0]?.totalRev ?? 0;
    const totalOrders = allOrdersRes[0]?.totalOrders ?? 0;
    const totalItemsSold = allOrdersRes[0]?.totalItems ?? 0;

    const todayRevenue = todayOrdersRes[0]?.totalRev ?? 0;
    const todayOrders = todayOrdersRes[0]?.totalOrders ?? 0;

    const monthRevenue = monthOrdersRes[0]?.totalRev ?? 0;
    const monthOrders = monthOrdersRes[0]?.totalOrders ?? 0;

    const topSellingProducts = topSellingRaw.map((item) => ({
      productName: item._id,
      totalSold: item.totalSold,
      totalRevenue: item.totalRevenue,
    }));

    return {
      totalRevenue,
      totalOrders,
      totalItemsSold,
      todayRevenue,
      todayOrders,
      monthRevenue,
      monthOrders,
      totalProducts,
      activeProducts,
      totalCategories: categories.length,
      totalStockAvailable,
      totalStockSold,
      topSellingProducts,
    };
  }

  /**
   * Detailed SMS OTP virtual rental statistics.
   */
  static async getSmsStats(): Promise<SmsStats> {
    const startOfDay = getStartOfDay();
    const startOfMonth = getStartOfMonth();

    const [
      totalOrders,
      completedOrders,
      canceledOrders,
      pendingOrders,
      allCostRes,
      todayCostRes,
      monthCostRes,
      topServicesRaw,
      topCountriesRaw,
    ] = await Promise.all([
      Order.countDocuments(),
      Order.countDocuments({ status: "COMPLETED" }),
      Order.countDocuments({ status: "CANCELED" }),
      Order.countDocuments({ status: "PENDING" }),
      Order.aggregate<{ totalCost: number }>([
        { $match: { status: "COMPLETED" } },
        { $group: { _id: null, totalCost: { $sum: "$cost" } } },
      ]),
      Order.aggregate<{ totalCost: number; count: number }>([
        { $match: { status: "COMPLETED", createdAt: { $gte: startOfDay } } },
        {
          $group: {
            _id: null,
            totalCost: { $sum: "$cost" },
            count: { $sum: 1 },
          },
        },
      ]),
      Order.aggregate<{ totalCost: number; count: number }>([
        { $match: { status: "COMPLETED", createdAt: { $gte: startOfMonth } } },
        {
          $group: {
            _id: null,
            totalCost: { $sum: "$cost" },
            count: { $sum: 1 },
          },
        },
      ]),
      Order.aggregate<{ _id: string; count: number; totalCost: number }>([
        { $match: { status: "COMPLETED" } },
        {
          $group: {
            _id: "$service",
            count: { $sum: 1 },
            totalCost: { $sum: "$cost" },
          },
        },
        { $sort: { count: -1 } },
        { $limit: 5 },
      ]),
      Order.aggregate<{ _id: number; count: number }>([
        { $match: { status: "COMPLETED" } },
        { $group: { _id: "$country", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 3 },
      ]),
    ]);

    const totalFinished = completedOrders + canceledOrders;
    const successRate =
      totalFinished > 0
        ? Math.round((completedOrders / totalFinished) * 1000) / 10
        : 0;

    const totalCost = allCostRes[0]?.totalCost ?? 0;
    const todayCost = todayCostRes[0]?.totalCost ?? 0;
    const todayCompletedCount = todayCostRes[0]?.count ?? 0;
    const monthCost = monthCostRes[0]?.totalCost ?? 0;
    const monthCompletedCount = monthCostRes[0]?.count ?? 0;

    const topServices = topServicesRaw.map((s) => ({
      service: s._id,
      count: s.count,
      totalCost: s.totalCost,
    }));

    const topCountries = topCountriesRaw.map((c) => ({
      country: c._id,
      count: c.count,
    }));

    return {
      totalOrders,
      completedOrders,
      canceledOrders,
      pendingOrders,
      successRate,
      totalCost,
      todayCost,
      todayCompletedCount,
      monthCost,
      monthCompletedCount,
      topServices,
      topCountries,
    };
  }
}
