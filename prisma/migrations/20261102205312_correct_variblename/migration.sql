/*
  Warnings:

  - You are about to drop the column `Side` on the `Order` table. All the data in the column will be lost.
  - You are about to drop the column `Status` on the `Order` table. All the data in the column will be lost.
  - Added the required column `side` to the `Order` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Order" DROP COLUMN "Side",
DROP COLUMN "Status",
ADD COLUMN     "side" TEXT NOT NULL,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'OPEN';
