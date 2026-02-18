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
        results: {}
      })
      .select('id')
      .single()

    if (error) throw error

    // GitHub Action wird automatisch vom DB-Trigger (on_scan_inserted) gestartet

    return new Response(
      JSON.stringify({
        success: true,
        version: "v3-db-trigger",
        scanId: data.id,
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      }
    )

  } catch (error) {
    return new Response(
      JSON.stringify({ success: false, error: error.message, version: "v3-db-trigger" }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400,
      }
    )
  }
})
