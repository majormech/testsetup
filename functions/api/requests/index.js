import { createStationRequest } from '../../../src/server.js';

export async function onRequestPost(context) {
  return createStationRequest(context.request, context.env);
}
