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

    const { clientId, domain, max_pages, scan_type, scan_id } = await req.json()

    if (!clientId || !domain) {
      throw new Error('Missing clientId or domain')
    }

    let scanId: string

    if (scan_id) {
      // Aufrufer hat bereits einen Eintrag erstellt (z.B. trigger-full-scan/route.ts)
      // — keinen zweiten anlegen, nur den vorhandenen verwenden.
      scanId = scan_id
    } else {
      // Scan-Eintrag anlegen — DB-Trigger (on-scan-inserted) startet danach GitHub Actions
      const { data, error } = await supabase
        .from('accessibility_scans')
        .insert({
          client_id: clientId,
          domain: domain,
          status: 'pending',
          max_pages: max_pages || 10,
          scan_type: scan_type || 'full',
        })
        .select('id')
        .single()

      if (error) throw error
      scanId = data.id
    }

    return new Response(
      JSON.stringify({
        success: true,
        version: "v4-scan-type",
        scanId,
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
