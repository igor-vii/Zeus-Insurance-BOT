import fastify from 'fastify';
import voteRoutes from './routes/votes';

const app = fastify({ logger: true });

app.register(voteRoutes);

app.listen({ port: Number(process.env.PORT) || 3000, host: '0.0.0.0' }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
});
