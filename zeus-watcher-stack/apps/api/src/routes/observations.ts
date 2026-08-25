import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { claimQueue } from '../lib/queue';

const ObservationSchema = z.object({
  chainId: z.number(),
  policyId: z.string(),
  requestId: z.string().regex(/^0x[0-9a-f]{64}$/),
  timestamp: z.number(),
  status: z.number().min(0).max(1),
  metadataHash: z.string().regex(/^0x[0-9a-f]{64}$/),
  nonce: z.number(),
  signature: z.string().regex(/^0x[0-9a-f]{130}$/),
});

export default async function observationRoutes(fastify: FastifyInstance) {
  fastify.post('/observations', async (request, reply) => {
    const body = ObservationSchema.parse(request.body);
    
    // Проверяем freshness (±2 минуты как в контракте)
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - body.timestamp) > 120) {
      return reply.code(400).send({ error: 'Timestamp outside contract window' });
    }

    // Ставим в очередь на реле
    await claimQueue.add('relay-observation', body, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    });

    return { queued: true };
  });

  // Batch endpoint
  fastify.post('/observations/batch', async (request, reply) => {
    const items = z.array(ObservationSchema).parse(request.body);
    const now = Math.floor(Date.now() / 1000);

    const jobs = items
      .filter(item => Math.abs(now - item.timestamp) <= 120)
      .map(item => claimQueue.add('relay-observation', item));

    await Promise.all(jobs);
    return { queued: jobs.length, rejected: items.length - jobs.length };
  });
}
