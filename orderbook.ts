interface BookOrder {
    id: number;
    userId: number;
    stockId: number;
    price: number;
    quantity: number;
    type: string;
    side: string;
}


// Define the shape of the whole orderbook
interface OrderBookType {
    [key: string]: {
        bids: BookOrder[];
        asks: BookOrder[];
};
}


// Apply the type , AXS , SOL they are symbolKey
const orderBook: OrderBookType = {
    "AXS": { bids: [], asks: [] },
    "SOL": { bids: [], asks: [] },
    "GGL": { bids: [], asks: [] }
};


export default orderBook