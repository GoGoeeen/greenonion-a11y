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
    let shareToken: string | null = null

    if (scan_id) {
      // Aufrufer hat bereits einen Eintrag erstellt (z.B. trigger-full-scan/route.ts)
      // — keinen zweiten anlegen, nur den vorhandenen verwenden.
      scanId = scan_id
      const { data: existing } = await supabase
        .from('accessibility_scans')
        .select('share_token')
        .eq('id', scan_id)
        .single()
      shareToken = existing?.share_token ?? null
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
        .select('id, share_token')
        .single()

      if (error) throw error
      scanId = data.id
      shareToken = data.share_token
    }

    return new Response(
      JSON.stringify({
        success: true,
        version: "v5-share-token",
        scanId,
        shareToken,
        shareLink: shareToken
          ? `https://gogoeeen.github.io/greenonion-a11y/report-viewer.html?token=${shareToken}`
          : null,
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
