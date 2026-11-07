import { PrismaClient } from './generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const adapter = new PrismaPg({
    connectionString: process.env.DIRECT_URL
})

const prisma = new PrismaClient({adapter});     // why this PrismaClient ask for {object parameter} -> question -> DONE


async function seed() {
    await prisma.stock.createMany({
        data: [
            {name: "Ruppe", Symbol: "INR"},
            {name: "Dollar", Symbol: "USD"},
            {name: "Axis", Symbol: "AXS"},
            {name: "Solana", Symbol: "SOL"},
            {name: "Google", Symbol: "GGL"}
        ],
        skipDuplicates: true            // --> why we writing this one
    })
    console.log("stocks added")
}

export default seed;