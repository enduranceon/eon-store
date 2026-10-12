import { supabase } from '@/api/db';
import { createCoachMatchClient } from '@/lib/coach-match-client';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL?.replace(/\/$/, '');
const PUBLIC_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

const client = createCoachMatchClient({
  supabaseUrl: SUPABASE_URL,
  publicKey: PUBLIC_KEY,
  getSession: () => supabase.auth.getSession(),
});

export const getCoachMatch = client.get;
export const issueCoachMatchInvite = client.issueInvite;
export const revokeCoachMatchInvite = client.revokeInvite;
export const reviewCoachMatch = client.review;
export const coachMatchPublicRequest = client.publicRequest;
