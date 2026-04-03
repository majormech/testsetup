import { adjustInventory } from '../../../src/server.js';

export async function onRequestPost(context) {
  return adjustInventory(context.request, context.env);
}
