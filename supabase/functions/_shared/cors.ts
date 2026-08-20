// CORS headers for browser calls. Auth is carried in the Authorization
// bearer header (not cookies), so a wildcard origin is safe here — no
// credentialed requests. Tighten to your app origin if you prefer.
export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
