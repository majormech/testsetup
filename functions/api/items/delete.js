import { deleteItem } from '../../../src/server.js';

export async function onRequestPost(context) {
  return deleteItem(context.request, context.env);
}
