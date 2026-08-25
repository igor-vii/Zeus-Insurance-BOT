import { Queue } from 'bullmq';
import { redis } from './redis';

export const claimQueue = new Queue('claims', { connection: redis });
