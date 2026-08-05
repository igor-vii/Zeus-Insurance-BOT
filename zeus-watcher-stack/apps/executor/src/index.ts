import { Worker } from 'bullmq';
import { redis } from './redis';
import { claimWorker } from './worker';

const worker = new Worker('claims', claimWorker, { connection: redis });

worker.on('completed', (job) => {
  console.log(`Job ${job.id} completed`, job.returnvalue);
});

worker.on('failed', (job, err) => {
  console.error(`Job ${job?.id} failed`, err);
});
