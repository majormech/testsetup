import { bootstrapData, json } from '../../src/server.js';

export async function onRequestGet(context) {
  return json(await bootstrapData(context.env.DB));
}
