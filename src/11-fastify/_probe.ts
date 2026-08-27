import Fastify from "fastify";
{
  const app = Fastify({ logger: false });
  const order: string[] = [];
  app.register(async () => { order.push("A"); });     // NOT awaited
  app.register(async () => { order.push("B"); });
  order.push("after register() calls");
  await app.ready();
  order.push("after ready()");
  console.log("without await:", order.join(" → "));
  await app.close();
}
{
  const app = Fastify({ logger: false });
  const order: string[] = [];
  await app.register(async () => { order.push("A"); });   // awaited
  order.push("after awaited register()");
  await app.ready();
  console.log("with await:   ", order.join(" → "));
  await app.close();
}
