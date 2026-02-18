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

    // --- Trigger GitHub Action ---
    const connectionToken = Deno.env.get('GITHUB_TOKEN')

    if (connectionToken) {
      console.log(`Triggering GitHub Action for ${domain}...`)

      const githubResponse = await fetch(
        `https://api.github.com/repos/GoGoeeen/greenonion-a11y/actions/workflows/scan.yml/dispatches`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${connectionToken}`,
            Accept: 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            ref: 'main',
            inputs: {
              domain: domain,
              client_id: clientId,
              scan_id: data.id, // ID from the newly created row
              max_pages: '5',   // Default or pass from req.json()
            },
          }),
        }
      )

      if (githubResponse.status === 204) {
        console.log('GitHub Action triggered successfully.')
        // Update status to 'queued' or leave as pending? 
        // Pending is fine, the action will set it to 'running'.
      } else {
        const errorText = await githubResponse.text()
        console.error('Failed to trigger GitHub Action:', errorText)
        // Optional: Update DB to reflect trigger failure
        await supabase
          .from('accessibility_scans')
          .update({
            status: 'failed',
            error_message: `GitHub Trigger Failed: ${githubResponse.status} ${errorText}`
          })
          .eq('id', data.id)
      }
    } else {
      console.warn('GITHUB_TOKEN not set. Skipping GitHub Action trigger.')
      // We don't fail the request, just log it, so local worker could still pick it up if running
    }

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
        status: 400,
      }
    )
  }
})
