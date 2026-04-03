import { lookupScan } from '../../src/server.js';

export async function onRequestGet(context) {
  return lookupScan(context.request, context.env);
}
