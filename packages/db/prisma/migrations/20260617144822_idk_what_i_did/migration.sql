/*
  Warnings:

  - You are about to drop the column `messages` on the `Chat` table. All the data in the column will be lost.
  - Added the required column `message` to the `Chat` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "OpType" AS ENUM ('CREATE', 'UPDATE', 'DELETE');

-- DropForeignKey
ALTER TABLE "Chat" DROP CONSTRAINT "Chat_roomId_fkey";

-- AlterTable
ALTER TABLE "Chat" DROP COLUMN "messages",
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "message" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Room" ADD COLUMN     "currentSeq" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- CreateTable
CREATE TABLE "Operation" (
    "id" BIGSERIAL NOT NULL,
    "roomId" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" "OpType" NOT NULL,
    "shapeId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Operation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Snapshot" (
    "id" BIGSERIAL NOT NULL,
    "roomId" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL,
    "state" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Operation_roomId_shapeId_idx" ON "Operation"("roomId", "shapeId");

-- CreateIndex
CREATE UNIQUE INDEX "Operation_roomId_seq_key" ON "Operation"("roomId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "Snapshot_roomId_seq_key" ON "Snapshot"("roomId", "seq");

-- CreateIndex
CREATE INDEX "Chat_roomId_idx" ON "Chat"("roomId");

-- CreateIndex
CREATE INDEX "Room_adminId_idx" ON "Room"("adminId");

-- AddForeignKey
ALTER TABLE "Operation" ADD CONSTRAINT "Operation_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Operation" ADD CONSTRAINT "Operation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Snapshot" ADD CONSTRAINT "Snapshot_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Chat" ADD CONSTRAINT "Chat_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;
