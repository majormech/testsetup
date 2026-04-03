import { createAdminStation, getAdminStations } from '../../../src/server.js';

export async function onRequestGet(context) {
  return getAdminStations(context.request, context.env);
}

export async function onRequestPost(context) {
  return createAdminStation(context.request, context.env);
}
