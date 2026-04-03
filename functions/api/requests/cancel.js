import { cancelStationRequest } from '../../../src/server.js';

export async function onRequestPost(context) {
  return cancelStationRequest(context.request, context.env);
}
