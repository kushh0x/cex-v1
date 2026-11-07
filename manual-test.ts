import { PrismaClient } from "./generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import "dotenv/config";

const BASE_URL = "http://localhost:3000";

// api.ts uses DIRECT_URL, so the test must use the same database.
const connectionString = process.env.DIRECT_URL;

if (!connectionString) {
    throw new Error("DIRECT_URL is missing from your .env file");
}

const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

function check(condition: boolean, message: string): void {
    if (!condition) {
        throw new Error(`TEST FAILED: ${message}`);
    }

    console.log(`✅ ${message}`);
}

async function requestJson(path: string, options: RequestInit = {}): Promise<any> {
    const response = await fetch(`${BASE_URL}${path}`, options);
    const responseText = await response.text();

    let data: any = {};

    try {
        data = responseText ? JSON.parse(responseText) : {};
    } catch {
        data = { message: responseText };
    }

    if (!response.ok) {
        throw new Error(
            `${options.method || "GET"} ${path} failed (${response.status}): ${responseText}`
        );
    }

    return data;
}

function postOptions(cookie: string, body: object): RequestInit {
    return {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Cookie: cookie
        },
        body: JSON.stringify(body)
    };
}

async function createUser(username: string): Promise<string> {
    await requestJson(
        "/signup",
        postOptions("", { username, password: "password123" })
    );

    const loginResponse = await fetch(`${BASE_URL}/signin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password: "password123" })
    });

    const loginText = await loginResponse.text();

    if (!loginResponse.ok) {
        throw new Error(`Signin failed for ${username}: ${loginText}`);
    }

    const setCookie = loginResponse.headers.get("set-cookie");

    if (!setCookie) {
        throw new Error(`No authentication cookie returned for ${username}`);
    }

    // Send only the cookie name/value pair in the Cookie request header.
    return setCookie.split(";")[0];
}

async function addINR(cookie: string, amount: number): Promise<void> {
    await requestJson("/onramp", postOptions(cookie, { amount }));
}

async function addAXS(username: string, amount: number, axsStockId: number): Promise<void> {
    const user = await prisma.user.findUnique({ where: { username } });

    if (!user) {
        throw new Error(`User not found: ${username}`);
    }

    await prisma.userBalance.upsert({
        where: {
            userId_stockId: {
                userId: user.id,
                stockId: axsStockId
            }
        },
        update: {
            available: { increment: amount }
        },
        create: {
            userId: user.id,
            stockId: axsStockId,
            available: amount
        }
    });
}

async function placeOrder(
    cookie: string,
    side: "BUY" | "SELL",
    price: number,
    quantity: number
): Promise<number> {
    const result = await requestJson(
        "/order",
        postOptions(cookie, {
            stockSymbol: "AXS",
            type: "LIMIT",
            side,
            price,
            quantity
        })
    );

    const orderId = Number(result.orderId);

    if (!Number.isInteger(orderId)) {
        throw new Error(`Order endpoint did not return a valid orderId: ${JSON.stringify(result)}`);
    }

    return orderId;
}

async function getOrderBook(cookie: string): Promise<any> {
    return requestJson("/orderbook/AXS", {
        headers: { Cookie: cookie }
    });
}

async function clearDatabase(): Promise<void> {
    // This clears PostgreSQL. The API's in-memory order book is cleared by
    // restarting the API server before running this test file.
    await prisma.fills.deleteMany({});
    await prisma.order.deleteMany({});
    await prisma.userBalance.deleteMany({});
    await prisma.user.deleteMany({});
}

async function runMasterTest(): Promise<void> {
    console.log("\n🚀 STARTING MASTER TEST SUITE 🚀\n");

    await clearDatabase();

    const axsStock = await prisma.stock.findUnique({ where: { Symbol: "AXS" } });

    if (!axsStock) {
        throw new Error("AXS stock was not found. Make sure the API seed has completed.");
    }

    // ==========================================
    // TEST 1: AUTHENTICATION AND ONRAMP
    // ==========================================
    console.log("--- TEST 1: AUTHENTICATION AND ONRAMP ---");

    const buyerCookie = await createUser("buyer");
    const sellerCookie = await createUser("seller");

    await addINR(buyerCookie, 5000);
    await addAXS("seller", 50, axsStock.id);

    const buyerBalanceResponse = await requestJson("/balance/inr", {
        headers: { Cookie: buyerCookie }
    });

    check(
        String(buyerBalanceResponse.message).includes("5000"),
        "Buyer received 5000 INR through onramp"
    );

    console.log("✅ Seller received 50 AXS.\n");

    // ==========================================
    // TEST 2: FULL MATCH
    // ==========================================
    console.log("--- TEST 2: FULL MATCH ---");

    const fullBuyOrderId = await placeOrder(buyerCookie, "BUY", 100, 10);
    const fullSellOrderId = await placeOrder(sellerCookie, "SELL", 100, 10);

    const fullBuyOrder = await prisma.order.findUnique({ where: { id: fullBuyOrderId } });
    const fullSellOrder = await prisma.order.findUnique({ where: { id: fullSellOrderId } });

    const buyerFills = await prisma.fills.findMany({
        where: { user: { username: "buyer" } }
    });
    const sellerFills = await prisma.fills.findMany({
        where: { user: { username: "seller" } }
    });

    check(buyerFills.length === 1, "Buyer received one fill");
    check(sellerFills.length === 1, "Seller received one fill");
    check(fullBuyOrder?.status === "FILLED", "BUY order status is FILLED");
    check(fullSellOrder?.status === "FILLED", "SELL order status is FILLED");

    const bookAfterFullMatch = await getOrderBook(buyerCookie);
    check(
        bookAfterFullMatch.bids.length === 0 && bookAfterFullMatch.asks.length === 0,
        "Order book is empty after the full match"
    );

    console.log("");

    // ==========================================
    // TEST 3: PARTIAL MATCH
    // Use price 90 so this resting BUY does not interfere with Test 4 at 100.
    // ==========================================
    console.log("--- TEST 3: PARTIAL MATCH ---");

    const buyer2Cookie = await createUser("buyer2");
    const seller2Cookie = await createUser("seller2");

    await addINR(buyer2Cookie, 5000);
    await addAXS("seller2", 50, axsStock.id);

    const partialBuyOrderId = await placeOrder(buyer2Cookie, "BUY", 90, 20);
    await placeOrder(seller2Cookie, "SELL", 90, 10);

    const partialBuyOrder = await prisma.order.findUnique({
        where: { id: partialBuyOrderId }
    });

    check(Number(partialBuyOrder?.filledQty) === 10, "BUY order filledQty is 10");
    check(
        partialBuyOrder?.status === "PARTIALLY_FILLED",
        "BUY order status is PARTIALLY_FILLED"
    );

    const bookAfterPartial = await getOrderBook(buyer2Cookie);
    const remainingPartialBid = bookAfterPartial.bids.find(
        (order: any) => order.id === partialBuyOrderId
    );

    check(
        Number(remainingPartialBid?.quantity) === 10,
        "10 AXS remain in the partially filled BUY order"
    );

    console.log("");

    // ==========================================
    // TEST 4: MULTIPLE ORDER MATCHING
    // ==========================================
    console.log("--- TEST 4: MULTIPLE ORDER MATCHING ---");

    const buyerA_Cookie = await createUser("buyer_multi_1");
    const buyerB_Cookie = await createUser("buyer_multi_2");
    const sellerMultiCookie = await createUser("seller_multi");

    await addINR(buyerA_Cookie, 5000);
    await addINR(buyerB_Cookie, 5000);
    await addAXS("seller_multi", 10, axsStock.id);

    const buyerAOrderId = await placeOrder(buyerA_Cookie, "BUY", 105, 4);
    const buyerBOrderId = await placeOrder(buyerB_Cookie, "BUY", 103, 3);
    const multiSellOrderId = await placeOrder(sellerMultiCookie, "SELL", 100, 10);

    const multiSellerFills = await prisma.fills.findMany({
        where: { user: { username: "seller_multi" } },
        orderBy: { price: "desc" }
    });

    console.log("\n--- EXECUTED TRADES ---");
    multiSellerFills.forEach((fill, index) => {
        console.log(`Trade ${index + 1}: ${fill.quantity} AXS @ ₹${fill.price}`);
    });

    // Two BUY orders are matched, so there are TWO trades.
    // The remaining 3 AXS are still an open SELL order, not a third trade.
    check(multiSellerFills.length === 2, "Exactly 2 trades executed");
    check(
        Number(multiSellerFills[0]?.price) === 105 &&
        Number(multiSellerFills[0]?.quantity) === 4,
        "Trade 1: 4 AXS executed at ₹105"
    );
    check(
        Number(multiSellerFills[1]?.price) === 103 &&
        Number(multiSellerFills[1]?.quantity) === 3,
        "Trade 2: 3 AXS executed at ₹103"
    );

    const multiSellOrder = await prisma.order.findUnique({
        where: { id: multiSellOrderId }
    });

    check(Number(multiSellOrder?.filledQty) === 7, "SELL order filledQty is 7");
    check(
        multiSellOrder?.status === "PARTIALLY_FILLED",
        "SELL order status is PARTIALLY_FILLED"
    );

    const bookAfterMultipleMatch = await getOrderBook(sellerMultiCookie);
    const remainingAsk = bookAfterMultipleMatch.asks.find(
        (order: any) => order.id === multiSellOrderId
    );

    check(
        Number(remainingAsk?.quantity) === 3,
        "Remaining SELL quantity is 3 AXS"
    );

    check(
        !bookAfterMultipleMatch.bids.some(
            (order: any) =>
                order.id === buyerAOrderId || order.id === buyerBOrderId
        ),
        "Both BUY orders from this test were removed from the order book"
    );

    console.log("\n✅ MULTIPLE ORDER MATCHING TEST PASSED!");
    console.log("   Trade 1: 4 AXS @ ₹105");
    console.log("   Trade 2: 3 AXS @ ₹103");
    console.log("   Remaining SELL order: 3 AXS @ ₹100\n");

    // ==========================================
    // TEST 5: GET ROUTES
    // ==========================================
    console.log("--- TEST 5: GET ROUTES ---");

    const balancesData = await requestJson("/balances", {
        headers: { Cookie: buyerA_Cookie }
    });
    const ordersData = await requestJson("/orders", {
        headers: { Cookie: buyerA_Cookie }
    });
    const fillsData = await requestJson("/fills", {
        headers: { Cookie: buyerA_Cookie }
    });
    const orderBookData = await getOrderBook(buyerA_Cookie);

    check(Array.isArray(balancesData.balances), "GET /balances works");
    check(Array.isArray(ordersData.orders), "GET /orders works");
    check(Array.isArray(fillsData.fills), "GET /fills works");
    check(
        Array.isArray(orderBookData.bids) && Array.isArray(orderBookData.asks),
        "GET /orderbook/AXS works"
    );

    console.log("");

    // ==========================================
    // TEST 6: CANCEL ORDER AND REFUND
    // ==========================================
    console.log("--- TEST 6: CANCEL ORDER AND REFUND ---");

    const cancelBuyerCookie = await createUser("cancel_buyer");
    await addINR(cancelBuyerCookie, 5000);

    // Price 80 does not match the resting SELL order at 100.
    const cancelOrderId = await placeOrder(cancelBuyerCookie, "BUY", 80, 10);

    const balanceBeforeCancel = await prisma.userBalance.findFirst({
        where: {
            user: { username: "cancel_buyer" },
            stock: { Symbol: "INR" }
        }
    });

    check(
        Number(balanceBeforeCancel?.available) === 4200 &&
        Number(balanceBeforeCancel?.locked) === 800,
        "800 INR is locked when the BUY order is placed"
    );

    await requestJson(`/order/${cancelOrderId}`, {
        method: "DELETE",
        headers: { Cookie: cancelBuyerCookie }
    });

    const balanceAfterCancel = await prisma.userBalance.findFirst({
        where: {
            user: { username: "cancel_buyer" },
            stock: { Symbol: "INR" }
        }
    });

    const cancelledOrder = await prisma.order.findUnique({
        where: { id: cancelOrderId }
    });

    const bookAfterCancel = await getOrderBook(cancelBuyerCookie);

    check(cancelledOrder?.status === "CANCELLED", "Order status is CANCELLED");
    check(
        Number(balanceAfterCancel?.available) === 5000 &&
        Number(balanceAfterCancel?.locked) === 0,
        "5000 INR is available and 0 INR is locked after cancellation"
    );
    check(
        !bookAfterCancel.bids.some((order: any) => order.id === cancelOrderId),
        "Cancelled BUY order was removed from the order book"
    );

    console.log("\n🏁 MASTER TEST SUITE PASSED 🏁\n");
}

runMasterTest()
    .catch((error) => {
        console.error("\n❌ MASTER TEST SUITE FAILED:", error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
