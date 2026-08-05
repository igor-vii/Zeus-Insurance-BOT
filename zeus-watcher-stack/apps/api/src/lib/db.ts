import { PrismaClient } from '@prisma/client';

declare global {
  var __db: PrismaClient | undefined;
}

export const prisma = global.__db ?? new PrismaClient();
if (process.env.NODE_ENV !== 'production') global.__db = prisma;
