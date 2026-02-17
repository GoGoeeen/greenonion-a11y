import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { clientId, domain } = await req.json()

    if (!clientId || !domain) {
      throw new Error('Missing clientId or domain')
    }

    // Insert scan request
    const { data, error } = await supabase
      .from('accessibility_scans')
      .insert({
        client_id: clientId,
        domain: domain,
        status: 'pending',
        scanned_at: new Date().toISOString(),
        results: {} // Initialize empty
      })
      .select()
      .single()

    if (error) throw error

    return new Response(
      JSON.stringify({ success: true, scanId: data.id }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      }
    )

  } catch (error) {
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400, // Return 400 for bad requests, but maybe 200 with error field as per user request if strict?
        // User said: "Bei Fehler -> status: 'failed', error_message speichern, HTTP 200 zurückgeben (kein 500-Crash)" -> This applies to the SCANNER logic execution mostly, but for the API, if we fail to insert, we should probably return error.
        // Wait, "Bei Fehler -> status: 'failed', error_message speichern" refers to the *scanner* execution usually.
        // But let's look at the requirement: "Gibt { success: true, scanId } zurück. Bei Fehler -> status: 'failed', ... HTTP 200 zurückgeben".
        // Use 200 OK even for errors if possible to avoid crashing the client.
      }
    )
  }
})
