import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

/**
 * Edge Function: on-scan-inserted
 * Wird vom PostgreSQL-Trigger via pg_net aufgerufen,
 * wenn ein neuer accessibility_scan mit status='pending' eingefügt wird.
 * Triggert die GitHub Action scan.yml via workflow_dispatch.
 */
Deno.serve(async (req) => {
  try {
    const { scan_id, client_id, domain, max_pages } = await req.json()

    if (!scan_id || !client_id || !domain) {
      console.error('Missing required fields:', { scan_id, client_id, domain })
      return new Response(
        JSON.stringify({ error: 'Missing scan_id, client_id, or domain' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      )
    }

    console.log(`on-scan-inserted: Triggering GitHub Action for scan ${scan_id}, domain ${domain}`)

    const githubToken = Deno.env.get('GITHUB_TOKEN')
    if (!githubToken) {
      console.error('GITHUB_TOKEN not set')
      await markScanFailed(scan_id, 'GITHUB_TOKEN not configured in Supabase secrets')
      return new Response(
        JSON.stringify({ error: 'GITHUB_TOKEN not configured' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      )
    }

    const githubResponse = await fetch(
      'https://api.github.com/repos/GoGoeeen/greenonion-a11y/actions/workflows/scan.yml/dispatches',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ref: 'main',
          inputs: {
            domain: domain,
            client_id: client_id,
            scan_id: scan_id,
            max_pages: String(max_pages || 20),
          },
        }),
      }
    )

    if (githubResponse.status === 204) {
      console.log(`GitHub Action triggered successfully for scan ${scan_id}`)
      return new Response(
        JSON.stringify({ success: true, scan_id }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }

    const errorText = await githubResponse.text()
    console.error(`GitHub trigger failed (${githubResponse.status}): ${errorText}`)
    await markScanFailed(scan_id, `GitHub Trigger Failed: ${githubResponse.status} ${errorText}`)

    return new Response(
      JSON.stringify({ error: 'GitHub trigger failed', status: githubResponse.status }),
      { status: 502, headers: { 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('on-scan-inserted error:', error.message)
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }
})

async function markScanFailed(scanId: string, errorMessage: string) {
  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )
    await supabase
      .from('accessibility_scans')
      .update({ status: 'failed', error_message: errorMessage })
      .eq('id', scanId)
  } catch (e) {
    console.error('Failed to mark scan as failed:', e.message)
  }
}
