import { recordClientError } from '../../src/server.js';

export async function onRequestPost(context) {
  return recordClientError(context.request, context.env);
}
