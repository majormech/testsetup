import { addItem, updateItem } from '../../src/server.js';

export async function onRequestPost(context) {
  return addItem(context.request, context.env);
}

export async function onRequestPut(context) {
  return updateItem(context.request, context.env);
}
