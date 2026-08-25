import { FastifyInstance } from 'fastify';
import { verifyMessage } from 'ethers';
import { z } from 'zod';
import { prisma } from '../lib/db';
import { redis } from '../lib/redis';
import { claimQueue } from '../lib/queue';

const VoteSchema = z.object({
  chainId: z.number(),
  policyId: z.string(),
  votes: z.array(z.object({
    watcher: z.string(),
    vote: z.boolean(),
    signature: z.string(),
    timestamp: z.number(),
  }))
});

const QUORUM = 3;

export default async function voteRoutes(fastify: FastifyInstance) {
  fastify.post('/votes/batch', async (request, reply) => {
    const body = VoteSchema.parse(request.body);
    const now = Date.now();

    // 1. Verify signatures & timestamps
    for (const v of body.votes) {
      if (Math.abs(now - v.timestamp) > 300_000) {
        return reply.code(400).send({ error: 'Stale vote' });
      }
      const msg = `ZeusVote:${body.chainId}:${body.policyId}:${v.watcher}:${v.vote}:${v.timestamp}`;
      const recovered = verifyMessage(msg, v.signature).toLowerCase();
      
      const valid = await prisma.vote.findFirst({
        where: { policyId: `${body.chainId}:${body.policyId}`, watcher: recovered }
      });
      // In production: check watcher registry on-chain or in DB
      if (!valid && process.env.SKIP_WATCHER_CHECK !== 'true') {
        return reply.code(401).send({ error: `Invalid watcher: ${v.watcher}` });
      }
    }

    const policyId = `${body.chainId}:${body.policyId}`;

    // 2. Upsert votes
    await prisma.$transaction(
      body.votes.map(v => prisma.vote.upsert({
        where: { policyId_watcher: { policyId, watcher: v.watcher } },
        update: { vote: v.vote, signature: v.signature, timestamp: new Date(v.timestamp) },
        create: { policyId, watcher: v.watcher, vote: v.vote, signature: v.signature, timestamp: new Date(v.timestamp) }
      }))
    );

    // 3. Check quorum
    const stats = await prisma.vote.groupBy({
      by: ['vote'],
      where: { policyId },
      _count: true
    });
    const yes = stats.find(s => s.vote === true)?._count ?? 0;
    const no = stats.find(s => s.vote === false)?._count ?? 0;

    let queued = false;
    if (yes >= QUORUM && no === 0) {
      const lockKey = `claim:${policyId}`;
      const locked = await redis.set(lockKey, '1', 'EX', 3600, 'NX');
      if (locked) {
        await claimQueue.add('execute', { chainId: body.chainId, policyId: body.policyId });
        await prisma.policy.updateMany({
          where: { id: policyId, status: 'pending' },
          data: { status: 'queued' }
        });
        queued = true;
      }
    }

    return { yes, no, queued };
  });

  fastify.get('/health', async () => ({ status: 'ok' }));
}
