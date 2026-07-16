export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // If it's a proxy request, redirect it to the target with appropriate headers
    if (url.pathname.startsWith('/proxy')) {
      const targetUrlStr = url.searchParams.get('url');
      if (!targetUrlStr) {
        return new Response('Missing URL parameter (?url=...)', { 
          status: 400,
          headers: { 'Access-Control-Allow-Origin': '*' }
        });
      }

      try {
        const targetUrl = new URL(targetUrlStr);

        // Prepare headers for the target request
        const headers = new Headers();
        const headersToForward = ['accept', 'accept-encoding', 'accept-language'];
        for (const h of headersToForward) {
          if (request.headers.has(h)) {
            headers.set(h, request.headers.get(h));
          }
        }
        
        // Emulate referer, origin, user-agent, and session headers
        // Support custom headers passed as URL parameters or fallback to default
        const referer = url.searchParams.get('ref') || 'https://ritzembeds.pages.dev/';
        const origin = url.searchParams.get('ori') || 'https://ritzembeds.pages.dev';
        const defaultUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
        const userAgent = url.searchParams.get('ua') || request.headers.get('user-agent') || defaultUa;
        const sessionId = url.searchParams.get('sess') || request.headers.get('x-playback-session-id');

        headers.set('Referer', referer);
        headers.set('Origin', origin);
        headers.set('User-Agent', userAgent);
        headers.set('Host', targetUrl.host);

        if (sessionId) {
          headers.set('x-playback-session-id', sessionId);
        }

        // Support HTTP Range requests (crucial for streaming video segments)
        if (request.headers.has('range')) {
          headers.set('Range', request.headers.get('range'));
        }

        const response = await fetch(targetUrl.toString(), {
          method: 'GET',
          headers: headers
        });

        // Add permissive CORS headers to the response so the browser can play it
        const corsHeaders = new Headers();
        corsHeaders.set('Access-Control-Allow-Origin', '*');
        corsHeaders.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        corsHeaders.set('Access-Control-Allow-Headers', '*');

        // Handle Redirects inside the proxy
        if (response.status >= 300 && response.status < 400) {
          const redirectLocation = response.headers.get('location');
          if (redirectLocation) {
            const proxyRedirect = new URL(url.origin + '/proxy');
            
            // Forward original header parameter configurations to the redirect URL
            const paramsToForward = ['ref', 'ori', 'ua', 'sess', 'st', 'cid'];
            for (const p of paramsToForward) {
              const val = url.searchParams.get(p);
              if (val) proxyRedirect.searchParams.set(p, val);
            }
            
            proxyRedirect.searchParams.set('url', new URL(redirectLocation, targetUrl.href).href);
            corsHeaders.set('Location', proxyRedirect.toString());
            return new Response(null, {
              status: response.status,
              headers: corsHeaders
            });
          }
        }

        const contentType = response.headers.get('content-type') || '';
        const isM3U8 = contentType.includes('mpegurl') || 
                       contentType.includes('mpegURL') || 
                       targetUrl.pathname.endsWith('.m3u8') || 
                       targetUrl.pathname.includes('.m3u8');
        const isMPD = contentType.includes('dash+xml') || 
                      targetUrl.pathname.endsWith('.mpd') || 
                      targetUrl.pathname.includes('.mpd');

        // Construct the base proxy URL for recursive manifest rewriting
        const proxyBase = new URL(url.origin + '/proxy');
        const paramsToForward = ['ref', 'ori', 'ua', 'sess', 'st', 'cid'];
        for (const p of paramsToForward) {
          const val = url.searchParams.get(p);
          if (val) {
            proxyBase.searchParams.set(p, val);
          }
        }

        // If it's a DASH playlist (.mpd), inject remote BaseURL so relative segment links resolve correctly in Shaka Player
        if (isMPD) {
          let text = await response.text();
          const baseDirUrl = targetUrl.href.substring(0, targetUrl.href.lastIndexOf('/') + 1);
          
          if (!text.includes('<BaseURL>') && !text.includes('<BaseURL ')) {
            // Insert BaseURL tag directly inside the <MPD> root tag
            text = text.replace(/<MPD([^>]*)>/i, `<MPD$1>\n  <BaseURL>${baseDirUrl}</BaseURL>`);
          }
          
          corsHeaders.set('Content-Type', 'application/dash+xml');
          return new Response(text, {
            status: response.status,
            headers: corsHeaders
          });
        }

        // If it's a playlist (.m3u8), rewrite any absolute/relative URLs in it to go through this proxy
        if (isM3U8) {
          let text = await response.text();
          const lines = text.split('\n');
          const rewrittenLines = lines.map(line => {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#')) {
              // This is a stream or segment URL - resolve to absolute then wrap with proxy
              try {
                const absoluteUrl = new URL(trimmed, targetUrl.href).href;
                const segmentProxy = new URL(proxyBase.toString());
                segmentProxy.searchParams.set('url', absoluteUrl);
                return segmentProxy.toString();
              } catch (e) {
                return line;
              }
            }
            // If the line contains a URI tag (e.g. key or media tag: #EXT-X-KEY:METHOD=AES-128,URI="https://...")
            if (trimmed.startsWith('#') && trimmed.includes('URI=')) {
              return line.replace(/URI="([^"]+)"/g, (match, p1) => {
                try {
                  const absoluteUrl = new URL(p1, targetUrl.href).href;
                  const keyProxy = new URL(proxyBase.toString());
                  keyProxy.searchParams.set('url', absoluteUrl);
                  return `URI="${keyProxy.toString()}"`;
                } catch (e) {
                  return match;
                }
              });
            }
            return line;
          });
          
          text = rewrittenLines.join('\n');
          corsHeaders.set('Content-Type', contentType || 'application/vnd.apple.mpegurl');
          return new Response(text, {
            status: response.status,
            headers: corsHeaders
          });
        }

        // For other files (like video segments .ts), stream the body directly
        corsHeaders.set('Content-Type', contentType);
        const headersToCopy = ['content-length', 'content-range', 'accept-ranges'];
        for (const h of headersToCopy) {
          if (response.headers.has(h)) {
            corsHeaders.set(h, response.headers.get(h));
          }
        }

        return new Response(response.body, {
          status: response.status,
          headers: corsHeaders
        });
      } catch (err) {
        return new Response('Proxy Server Error: ' + err.message, {
          status: 500,
          headers: { 
            'Access-Control-Allow-Origin': '*',
            'Content-Type': 'text/plain'
          }
        });
      }
    }

    // Otherwise, serve the static assets from Cloudflare Pages
    return env.ASSETS.fetch(request);
  }
};
