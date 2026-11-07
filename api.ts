import "dotenv/config"

import { validation, authMiddleware } from "./middleware";
import { signupSchema, signinSchema } from './schema';
import seed from './seed';
import orderBook from "./orderbook";

import express from 'express';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import cookieParser from "cookie-parser";


import { PrismaClient } from './generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const adapter = new PrismaPg({
    connectionString: process.env.DIRECT_URL
})

const prisma = new PrismaClient({ adapter });

const app = express();
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
    throw new Error('JWT_SECRET is missing in .env file')
}

app.use(express.json());
app.use(cookieParser());

app.post("/signup", validation(signupSchema), async (req, res) => {

    const { username, password } = req.body;


    const existingUser = await prisma.user.findUnique({
        where: {
            username: username
        }
    })

    if (existingUser) {
        res.status(409).json({
            message: "this username already exist"
        })
        return;
    }

    const hashedPassword = await argon2.hash(password)

    await prisma.user.create({
        data: {
            username,
            password: hashedPassword,
        }
    })

    res.json({
        message: 'you have signed up successfully'
    })
})

app.post("/signin", validation(signinSchema), async (req, res) => {

    const { username, password } = req.body;

    const existingUser = await prisma.user.findUnique({
        where: {
            username: username
        }
    })

    if (!existingUser) {
        res.status(401).json({
            message: "this user doesn't exist already exist"
        })
        return;
    }

    const isMatch = await argon2.verify(existingUser.password, password);

    if (!isMatch) {
        res.status(401).json({
            message: "password is incorrect"
        })
        return
    }

    const token = jwt.sign({
        userId: existingUser.id
    }, JWT_SECRET)

    res.cookie("token", token, {
        httpOnly: true
    })

    res.json({
        message: "you have logged in successfully"
    })
})

seed();

app.post("/onramp", authMiddleware, async (req, res) => {

    const userId = req.userId as number;
    const { amount } = req.body;

    const inrStock = await prisma.stock.findUnique({
        where: {
            Symbol: "INR"
        }
    })

    if (!inrStock) {
        return res.status(401).json({
            message: "this currency is not suppported by us"
        })
    }
    const balance = await prisma.userBalance.upsert({
        where: {
            userId_stockId: {
                userId: userId,
                stockId: inrStock.id
            }
        },
        update: {
            available: {
                increment: amount
            }
        },
        create: {
            userId: userId,
            stockId: inrStock.id,
            available: amount
        }
    })

    res.json({
        message: "Onramp successful",
        newBalance: balance.available
    });

})


app.post("/order", authMiddleware, async (req, res) => {

    const userId = req.userId as number;
    const { stockSymbol, type, side, price, quantity } = req.body;

    const stock = await prisma.stock.findUnique({
        where: {
            Symbol: stockSymbol
        }
    });

    if (!stock) {
        return res.status(404).json({ message: "Stock not found" });
    }

    const totalCost = price * quantity;

    if (side === 'BUY') {

        const inrStock = await prisma.stock.findUnique({ where: { Symbol: "INR" } });

        // yaha par hmare pass stockId nhi thi tho hmne findFirst use kiya
        const userBalance = await prisma.userBalance.findFirst({
            where: {
                userId: userId,
                stockId: inrStock?.id
            }
        })


        // 3. Check if they have enough money
        if (!userBalance || userBalance.available < totalCost) {
            return res.status(403).json({
                message: "you don't have enough money in your bank account"
            })
        }

        // we now have to move that money in their locked account
        // 4. UPDATE DATABASE: Move money from available to locked

        await prisma.userBalance.update({
            where: {
                userId_stockId: {
                    userId: userId,
                    stockId: inrStock!.id
                }
            },
            data: {
                available: {
                    decrement: totalCost
                },
                locked: {
                    increment: totalCost
                }
            }
        })


    } else if (side === "SELL") {   // in sell part we will lock their shares not amount

        // in sell we should lock the stocks quantity not the money like the side BUY
        const balance = await prisma.userBalance.findUnique({
            where: {
                userId_stockId: {
                    userId,
                    stockId: stock.id
                }
            }
        })

        if (!balance || balance.available < quantity) {
            return res.status(400).json({ message: "Insufficient shares to sell" });
        }

        // Deduct from STOCK available, add to STOCK locked
        await prisma.userBalance.update({
            where: {
                userId_stockId: {
                    userId,
                    stockId: stock.id
                }
            },
            data: {
                available: {
                    decrement: quantity
                },
                locked: {
                    increment: quantity
                }
            }
        })
    }

    // 5. SAVE ORDER TO DATABASE

    const newOrder = await prisma.order.create({
        data: {
            stockId: stock.id,
            price: price,
            quantity: quantity,
            type: type,
            side: side,
            userId: userId,
            status: "OPEN"
        }
    })


    // 6. PUSH TO IN-MEMORY ORDERBOOK

    const symbolKey = stock.Symbol;

    // Safety Check -> if we don't have any stock it will kind of create it
    if (!orderBook[symbolKey]) {
        orderBook[symbolKey] = {
            bids: [],
            asks: []
        }
    }

    // here we are pushing the order in the orderbook
    if (side === "BUY") {
        orderBook[symbolKey].bids.push(newOrder);
    } else {
        orderBook[symbolKey].asks.push(newOrder);
    }

    // sorting logic
    orderBook[symbolKey].asks.sort((a, b) => a.price - b.price);
    orderBook[symbolKey].bids.sort((a, b) => b.price - a.price);


    // now the machine engine part -> where trade will actually happen
    if (side === "BUY") {

        const inrCurrency = await prisma.stock.findUnique({
            where: {
                Symbol: "INR"
            }
        })

        const asks = orderBook[symbolKey].asks;

        let remainingQty = quantity;

        while (remainingQty > 0 && asks.length > 0) {


            const sellOrder = asks[0];

            if (sellOrder!.price <= price) {

                const tradeQty = Math.min(sellOrder!.quantity, remainingQty);
                const tradeValue = tradeQty * sellOrder!.price;

                await prisma.fills.create({
                    data: {
                        quantity: tradeQty,
                        side: side,
                        type: type,
                        price: sellOrder!.price,
                        stockId: stock.id,
                        userId: userId,
                        originalOrderId: newOrder.id
                    }
                })

                await prisma.fills.create({
                    data: {
                        quantity: tradeQty,
                        side: side === "BUY" ? "SELL" : "BUY",
                        type: type,
                        price: sellOrder!.price,
                        stockId: stock.id,
                        userId: sellOrder!.userId,
                        originalOrderId: sellOrder!.id
                    }
                });

                // update the buyers amount
                await prisma.userBalance.update({
                    where: {
                        userId_stockId: {
                            userId: userId,
                            stockId: inrCurrency!.id
                        }
                    },
                    data: {
                        locked: { decrement: tradeValue }
                    }
                })

                // update the share amount of the user
                await prisma.userBalance.upsert({
                    where: {
                        userId_stockId: {
                            userId: userId,
                            stockId: stock.id
                        }
                    },
                    update: {
                        available: { increment: tradeQty }
                    },
                    create: {
                        userId: userId,
                        stockId: stock.id,
                        available: tradeQty
                    }
                })

                // update the seller amount
                await prisma.userBalance.update({
                    where: {
                        userId_stockId: {
                            userId: sellOrder!.userId,
                            stockId: stock.id
                        }
                    },
                    data: {
                        locked: { decrement: tradeQty }
                    }
                })

                await prisma.userBalance.upsert({
                    where: {
                        userId_stockId: {
                            userId: sellOrder!.userId,
                            stockId: inrCurrency!.id
                        }
                    },
                    update: {
                        available: { increment: tradeValue }
                    },
                    create: {
                        userId: sellOrder!.userId,
                        stockId: inrCurrency!.id,
                        available: tradeValue
                    }
                })

                // Update the DB Order statuses
                const newOrderStatus = tradeQty === remainingQty ? "FILLED" : "PARTIALLY_FILLED";
                const restingOrderStatus = tradeQty === sellOrder!.quantity ? "FILLED" : "PARTIALLY_FILLED";

                // we have a matched and now we are updating both rows of order table
                await prisma.order.update({
                    where: {
                        id: newOrder.id,
                    },
                    data: {
                        status: newOrderStatus,
                        filledQty: {
                            increment: tradeQty
                        }
                    }
                })

                await prisma.order.update({
                    where: {
                        id: sellOrder!.id
                    },
                    data: {
                        status: restingOrderStatus,
                        filledQty: {
                            increment: tradeQty
                        }
                    }
                })


                // 1. Handle the resting order (The Seller) -> now we have to remove the seller from the orderbook which is in memory database
                if (tradeQty === sellOrder!.quantity) {
                    asks.splice(0, 1);
                } else {
                    sellOrder!.quantity -= tradeQty;
                }

                // Deduct from remainingQty
                remainingQty -= tradeQty;

                // handle the buyers one
                if (remainingQty === 0) {
                    const index = orderBook[stockSymbol]!.bids.findIndex(b => b.id === newOrder.id);

                    if (index != -1) {
                        orderBook[stockSymbol]!.bids.splice(index, 1);
                    }
                } else {
                    // If the buyer still wants more shares, update their quantity in memory
                    const currenctBuyOrder = orderBook[stockSymbol]?.bids.find(b => b.id === newOrder.id);
                    if (currenctBuyOrder) {
                        currenctBuyOrder.quantity -= tradeQty;
                    }
                }

                console.log("Match Found Buyer wants ", remainingQty, " seller has ", sellOrder!.quantity);
            } else {
                break;
            }
        }
    }

    else if (side === "SELL") {

        const inrCurrency = await prisma.stock.findUnique({
            where: {
                Symbol: "INR"
            }
        })
        const bids = orderBook[symbolKey].bids;

        let remainingQty = quantity;

        while (remainingQty > 0 && bids.length > 0) {

            const buyOrder = bids[0];

            if (buyOrder!.price >= price) {


                const tradeQty = Math.min(buyOrder!.quantity, remainingQty);
                const tradeValue = tradeQty * buyOrder!.price;

                await prisma.fills.create({
                    data: {
                        quantity: tradeQty,
                        side: side,
                        type: type,
                        price: buyOrder!.price,
                        stockId: stock.id,
                        userId: userId,
                        originalOrderId: newOrder.id
                    }
                })

                await prisma.fills.create({
                    data: {
                        quantity: tradeQty,
                        side: side === "BUY" ? "SELL" : "BUY",
                        type: type,
                        price: buyOrder!.price,
                        stockId: stock.id,
                        userId: buyOrder!.userId,
                        originalOrderId: buyOrder!.id
                    }
                });


                // seller locked share decrement
                await prisma.userBalance.update({
                    where: {
                        userId_stockId: {
                            userId: userId,
                            stockId: stock.id
                        }
                    },
                    data: {
                        locked: { decrement: tradeQty }
                    }
                })

                // seller increment the amt
                await prisma.userBalance.upsert({
                    where: {
                        userId_stockId: {
                            userId: userId,
                            stockId: inrCurrency!.id
                        }
                    },
                    update: {
                        available: { increment: tradeValue }
                    },
                    create: {
                        userId: userId,
                        stockId: inrCurrency!.id,
                        available: tradeValue
                    }
                })

                // buyer increment the share
                await prisma.userBalance.upsert({
                    where: {
                        userId_stockId: {
                            userId: buyOrder!.userId,
                            stockId: stock.id
                        }
                    },
                    update: {
                        available: { increment: tradeQty }
                    },
                    create: {
                        userId: buyOrder!.userId,
                        stockId: stock.id,
                        available: tradeQty
                    }
                })

                // buyer decrement the locked amount
                await prisma.userBalance.update({
                    where: {
                        userId_stockId: {
                            userId: buyOrder!.userId,
                            stockId: inrCurrency!.id
                        }
                    },
                    data: {
                        locked: { decrement: tradeValue }
                    }
                })


                // update the db Order status
                const newOrderStatus = tradeQty === remainingQty ? "FILLED" : "PARTIALLY_FILLED";
                const restingOrderStatus = tradeQty === buyOrder!.quantity ? "FILLED" : "PARTIALLY_FILLED";


                await prisma.order.update({
                    where: {
                        id: newOrder.id
                    },
                    data: {
                        status: newOrderStatus,
                        filledQty: {
                            increment: tradeQty
                        }
                    }
                })

                await prisma.order.update({
                    where: {
                        id: buyOrder!.id
                    },
                    data: {
                        status: restingOrderStatus,
                        filledQty: {
                            increment: tradeQty
                        }
                    }
                })

                // handle the buyer request
                if (tradeQty === buyOrder?.quantity) {
                    bids.splice(0, 1);
                } else {
                    buyOrder!.quantity -= tradeQty;
                }

                // Deduct from remainingQty
                remainingQty -= tradeQty;

                // handle the seller request
                if (remainingQty === 0) {
                    const index = orderBook[stockSymbol]!.asks.findIndex(s => s.id === newOrder.id);

                    if (index != -1) {
                        orderBook[stockSymbol]!.asks.splice(index, 1);
                    }
                } else {
                    const currentSellOrder = orderBook[stockSymbol]!.asks.find(s => s.id === newOrder.id);
                    if (currentSellOrder) {
                        currentSellOrder.quantity -= tradeQty;
                    }
                }

                console.log("Match Found Buyer wants ", quantity, " seller has ", buyOrder!.quantity);
            } else {
                break;
            }
        }
    }

    console.log(orderBook);

    res.json({
        message: `${side} order placed successfully`,
        orderId: newOrder.id
    })


})


app.get("/balances", authMiddleware, async (req, res) => {

    const userId = req.userId as number;

    const balances = await prisma.userBalance.findMany({
        where: {
            userId: userId
        },
        include: {
            stock: true
        }

    });

    console.log(balances.length);

    res.json({ balances })
})


app.get("/balance/inr", authMiddleware, async (req, res) => {

    const userId = req.userId as number;

    const inrStockId = await prisma.stock.findUnique({
        where: {
            Symbol: "INR"
        }
    })
    const inrCurrency = await prisma.userBalance.findUnique({
        where: {
            userId_stockId: {
                userId,
                stockId: inrStockId!.id
            }
        }
    })

    const balance = inrCurrency!.available;
    res.json({
        message: `${balance} this much money is in wallet`
    })
})


app.get("/orders", authMiddleware, async (req, res) => {

    const userId = req.userId as number;

    const orders = await prisma.order.findMany({
        where: {
            userId: userId
        }
    })

    console.log(orders);

    res.json({ orders })
})


app.get("/order/:orderId", authMiddleware, async (req, res) => {

    const userId = req.userId as number;
    const orderId = Number(req.params.orderId);

    const order = await prisma.order.findFirst({
        where: {
            userId,
            id: orderId,
        }
    })

    res.json({ order })

})

// 2nd most important route to build
app.delete("/order/:orderId", authMiddleware, async (req, res) => {

    const userId = req.userId as number;
    const orderId = Number(req.params.orderId);

    const order = await prisma.order.findFirst({
        where: {
            id: orderId,
            userId: userId
        }
    });

    if (!order) {
        return res.status(404).json({
            message: "Order not found or you don't own it"
        });
    }

    if (order.status !== "OPEN" && order.status !== "PARTIALLY_FILLED") {
        return res.status(400).json({
            message: "This order is already filled or cancelled"
        });
    }

    const remainingQty = order.quantity - order.filledQty;

    // REFUND THE USER'S MONEY OR SHARES
    const inrStock = await prisma.stock.findUnique({ where: { Symbol: "INR" } });

    if (order.side === "BUY") { // locked in the userBalance table so we need to refund that amount to the user
        // Refund their locked INR
        const refundAmount = remainingQty * order.price;
        await prisma.userBalance.update({
            where: {
                userId_stockId: {
                    userId: userId,
                    stockId: inrStock!.id
                }
            },
            data: {
                available: { increment: refundAmount },
                locked: { decrement: refundAmount }
            }
        })
    }
     else if (order.side === "SELL") {
        // Refund their locked Shares
        await prisma.userBalance.update({
            where: { userId_stockId: { userId: userId, stockId: order.stockId } },
            data: {
                available: { increment: remainingQty },
                locked: { decrement: remainingQty }
            }
        });
    }

    // UPDATE THE DATABASE STATUS
    // We don't delete the order; we mark it as CANCELLED to keep history intact
    const updatedOrder = await prisma.order.update({
        where: { id: orderId },
        data: { status: "CANCELLED" }
    });

    // REMOVE FROM IN-MEMORY ORDERBOOK
    const stock = await prisma.stock.findUnique({ where: { id: order.stockId } });
    const symbolKey = stock!.Symbol;

    // we are updating -> in memory db
    if (orderBook[symbolKey]) {
        if (order.side === "BUY") {
            // Find the index of the order in the bids array
            const index = orderBook[symbolKey].bids.findIndex((o: any) => o.id === orderId);

            if (index !== -1) {
                orderBook[symbolKey].bids.splice(index, 1);
            }

        } else if (order.side === "SELL") {
            // Find the index of the order in the asks array
            const index = orderBook[symbolKey].asks.findIndex((o: any) => o.id === orderId);

            if (index !== -1) {
                orderBook[symbolKey].asks.splice(index, 1);
            }
        }
    }

    // 5. Send final response
    res.json({
        message: "Order cancelled and funds refunded successfully",
        order: updatedOrder
    });
});


app.get("/fills", authMiddleware, async (req, res) => {

    const userId = req.userId as number;

    const fills = await prisma.fills.findMany({
        where: {
            userId: userId
        },
        include: {
            stock: true
        }
    })

    console.log(fills.length);

    res.json({ fills })

})


app.get("/orderbook/:symbol", authMiddleware, async (req, res) => {

    const userId = req.userId as number;
    const symbol = req.params.symbol as string;

    const book = orderBook[symbol];
    if (!book) {
        return res.status(404).json({ message: "This stock does not exist in the orderbook" });
    }

    res.json({
        symbol,
        bids: book.bids,
        asks: book.asks
    })


})


app.listen(3000, () => console.log('server is running on the port 3000'));
