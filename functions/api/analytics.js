import { getAnalytics } from '../../src/server.js';

export async function onRequestGet(context) {
  return getAnalytics(context.request, context.env);
}
