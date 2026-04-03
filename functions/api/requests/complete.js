import { completeStationRequests } from '../../../src/server.js';

export async function onRequestPost(context) {
  return completeStationRequests(context.request, context.env);
}
