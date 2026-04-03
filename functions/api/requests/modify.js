import { modifyStationRequest } from '../../../src/server.js';

export async function onRequestPost(context) {
  return modifyStationRequest(context.request, context.env);
}
