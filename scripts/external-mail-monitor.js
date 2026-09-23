#!/usr/bin/env node

/**
 * External Mail Provider Status Monitor
 *
 * This script monitors the status of major email providers (Gmail, Outlook.com, iCloud Mail)
 * and automatically creates/updates GitHub issues in the status.forwardemail.net repository
 * when outages are detected.
 *
 * Data Sources:
 * - Google: https://www.google.com/appsstatus/dashboard/en/feed.atom
 * - Apple: https://www.apple.com/support/systemstatus/data/system_status_en_US.js
 * - Microsoft: https://status.cloud.microsoft/api/feed/mac
 *
 * @see https://github.com/forwardemail/status.forwardemail.net
 */

const https = require('node:https');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { parseString } = require('xml2js');

// Configuration
const CONFIG = {
  owner: 'forwardemail',
  repo: 'status.forwardemail.net',
  labels: ['maintenance'],
  stateFile: '.external-mail-status.json',
  feeds: {
    google: {
      url: 'https://www.google.com/appsstatus/dashboard/en/feed.atom',
      name: 'Gmail',
      keywords: ['gmail'],
      type: 'atom'
    },
    apple: {
      url: 'https://www.apple.com/support/systemstatus/data/system_status_en_US.js',
      name: 'iCloud Mail',
      keywords: ['icloud mail'],
      type: 'json'
    },
    microsoft: {
      url: 'https://status.cloud.microsoft/api/feed/mac',
      name: 'Outlook.com / Microsoft 365',
      keywords: ['outlook', 'microsoft 365', 'exchange'],
      type: 'rss'
    }
  }
};

/**
 * Fetch data from a URL with retry logic
 * @param {string} url - URL to fetch
 * @param {number} retries - Number of retries remaining
 * @returns {Promise<string>} - Response body
 */
function fetchUrl(url, retries = 3) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const request = client.get(url, {
      headers: {
        'User-Agent': 'ForwardEmail-StatusMonitor/1.0',
        Accept: '*/*'
      }
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        fetchUrl(response.headers.location, retries).then(resolve).catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        const error = new Error(`HTTP ${response.statusCode} for ${url}`);
        if (retries > 0) {
          console.log(`Retrying ${url} (${retries} retries left)...`);
          setTimeout(() => {
            fetchUrl(url, retries - 1).then(resolve).catch(reject);
          }, 1000);
          return;
        }
        reject(error);
        return;
      }

      let data = '';
      response.on('data', (chunk) => {
        data += chunk;
      });
      response.on('end', () => resolve(data));
      response.on('error', reject);
    });
    request.on('error', (error) => {
      if (retries > 0) {
        console.log(`Retrying ${url} after error (${retries} retries left)...`);
        setTimeout(() => {
          fetchUrl(url, retries - 1).then(resolve).catch(reject);
        }, 1000);
        return;
      }
      reject(error);
    });
    request.setTimeout(30_000, () => {
      request.destroy();
      const error = new Error(`Timeout fetching ${url}`);
      if (retries > 0) {
        console.log(`Retrying ${url} after timeout (${retries} retries left)...`);
        setTimeout(() => {
          fetchUrl(url, retries - 1).then(resolve).catch(reject);
        }, 1000);
        return;
      }
      reject(error);
    });
  });
}

/**
 * Parse XML to JavaScript object
 * @param {string} xml - XML string
 * @returns {Promise<object>} - Parsed object
 */
function parseXml(xml) {
  return new Promise((resolve, reject) => {
    parseString(xml, { explicitArray: false }, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

/**
 * Format duration from milliseconds
 * @param {number} ms - Duration in milliseconds
 * @returns {string} - Formatted duration
 */
function formatDuration(ms) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMins = minutes % 60;
  if (remainingMins > 0) {
    return `${hours} hour${hours === 1 ? '' : 's'} ${remainingMins} minute${remainingMins === 1 ? '' : 's'}`;
  }

  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

/**
 * Parse Google Workspace Atom feed for Gmail incidents
 * @returns {Promise<Array>} - Array of incident objects
 */
async function parseGoogleFeed() {
  const incidents = [];

  try {
    const data = await fetchUrl(CONFIG.feeds.google.url);
    const parsed = await parseXml(data);

    if (!parsed.feed || !parsed.feed.entry) {
      console.log('Google feed: No entries found');
      return incidents;
    }

    const entries = Array.isArray(parsed.feed.entry) ? parsed.feed.entry : [parsed.feed.entry];

    // Group entries by incident ID (from link)
    const incidentMap = new Map();

    for (const entry of entries) {
      const link = entry.link?.$ ? entry.link.$.href : (entry.link?.href || entry.link);
      const summary = entry.summary?._ || entry.summary || '';
      const title = entry.title || '';

      // Check if this is Gmail-related
      const isGmail = summary.toLowerCase().includes('gmail') ||
                      title.toLowerCase().includes('gmail') ||
                      summary.toLowerCase().includes('affected products: gmail');

      if (!isGmail) continue;

      // Extract incident ID from link
      const incidentIdMatch = link?.match(/incidents\/([^/]+)/);
      const incidentId = incidentIdMatch ? incidentIdMatch[1] : null;

      if (!incidentId) continue;

      // Only keep the most recent update for each incident
      if (!incidentMap.has(incidentId)) {
        // Check if resolved
        const isResolved = title.toLowerCase().includes('resolved') ||
                          summary.toLowerCase().includes('resolved') ||
                          summary.toLowerCase().includes('issue has been resolved');

        // Extract start time from summary
        const startTimeMatch = summary.match(/incident began at\s*<strong>([^<]+)<\/strong>/i) ||
                              summary.match(/beginning on\s+\w+,\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})/i);

        // Clean up description
        let description = summary.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        // Extract the main message
        const descMatch = description.match(/Description\s+(.+?)(?:We will provide|$)/i);
        if (descMatch) {
          description = descMatch[1].trim();
        }

        incidents.push({
          provider: 'google',
          service: 'Gmail',
          id: incidentId,
          title: title.split('\n')[0].slice(0, 200),
          description: description.slice(0, 1000),
          link,
          startTime: startTimeMatch ? startTimeMatch[1] : null,
          updated: entry.updated,
          isResolved
        });

        incidentMap.set(incidentId, true);
      }
    }
  } catch (error) {
    console.error('Error parsing Google feed:', error.message);
  }

  return incidents;
}

/**
 * Parse Apple System Status JSON for iCloud Mail incidents
 * @returns {Promise<Array>} - Array of incident objects
 */
async function parseAppleFeed() {
  const incidents = [];

  try {
    const data = await fetchUrl(CONFIG.feeds.apple.url);

    // Apple returns JSONP-like format, extract JSON
    let jsonStr = data;
    if (data.includes('jsonCallback(')) {
      jsonStr = data.replace(/^[^(]+\(/, '').replace(/\);?\s*$/, '');
    }

    const parsed = JSON.parse(jsonStr);

    if (!parsed.services) {
      console.log('Apple feed: No services found');
      return incidents;
    }

    for (const service of parsed.services) {
      // Check if this is iCloud Mail
      if (service.serviceName?.toLowerCase() !== 'icloud mail') {
        continue;
      }

      if (!service.events || service.events.length === 0) {
        continue;
      }

      for (const event of service.events) {
        const startTime = event.epochStartDate ? new Date(event.epochStartDate).toISOString() : null;
        const endTime = event.epochEndDate ? new Date(event.epochEndDate).toISOString() : null;
        const isResolved = event.eventStatus === 'resolved';

        // Calculate duration if both times available
        let duration = null;
        if (event.epochStartDate && event.epochEndDate) {
          const durationMs = event.epochEndDate - event.epochStartDate;
          duration = formatDuration(durationMs);
        }

        incidents.push({
          provider: 'apple',
          service: 'iCloud Mail',
          id: event.messageId || `apple-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          title: `iCloud Mail ${event.statusType || 'Issue'}`,
          description: event.message || 'iCloud Mail service issue detected.',
          link: 'https://www.apple.com/support/systemstatus/',
          startTime,
          endTime,
          duration,
          updated: event.datePosted,
          isResolved,
          usersAffected: event.usersAffected
        });
      }
    }
  } catch (error) {
    console.error('Error parsing Apple feed:', error.message);
  }

  return incidents;
}

/**
 * Parse Microsoft Status RSS feed for Outlook/M365 incidents
 * @returns {Promise<Array>} - Array of incident objects
 */
async function parseMicrosoftFeed() {
  const incidents = [];

  try {
    const data = await fetchUrl(CONFIG.feeds.microsoft.url);
    const parsed = await parseXml(data);

    if (!parsed.rss || !parsed.rss.channel || !parsed.rss.channel.item) {
      console.log('Microsoft feed: No items found');
      return incidents;
    }

    const items = Array.isArray(parsed.rss.channel.item) ?
      parsed.rss.channel.item : [parsed.rss.channel.item];

    for (const item of items) {
      const title = item.title || '';
      const description = item.description || '';
      const status = item.status || '';

      // Check if this is related to Outlook/Exchange/M365
      const isMailRelated = title.toLowerCase().includes('outlook') ||
                           title.toLowerCase().includes('exchange') ||
                           title.toLowerCase().includes('microsoft 365') ||
                           description.toLowerCase().includes('outlook') ||
                           description.toLowerCase().includes('exchange') ||
                           description.toLowerCase().includes('email');

      // Microsoft MAC feed shows overall status, not specific incidents
      // We'll create an incident if status is not "Available"
      const isOutage = status.toLowerCase() !== 'available';

      if (isOutage || isMailRelated) {
        // Determine resolution status from the feed status field
        const isResolved = status.toLowerCase() === 'resolved' ||
                          status.toLowerCase() === 'service restored' ||
                          status.toLowerCase() === 'available';

        incidents.push({
          provider: 'microsoft',
          service: 'Outlook.com / Microsoft 365',
          id: item.guid?._ || item.guid || `ms-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          title: title.slice(0, 200),
          description: description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1000),
          link: item.link || 'https://status.cloud.microsoft/',
          updated: item.pubDate,
          isResolved,
          status
        });
      }
    }
  } catch (error) {
    console.error('Error parsing Microsoft feed:', error.message);
  }

  return incidents;
}

/**
 * GitHub API request helper with retry logic
 * @param {string} method - HTTP method
 * @param {string} apiPath - API path
 * @param {object} body - Request body
 * @param {number} retries - Number of retries remaining
 * @returns {Promise<object>} - Response data
 */
async function githubApi(method, apiPath, body = null, retries = 3) {
  const token = process.env.GH_PAT || process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('GitHub token not found. Set GH_PAT or GITHUB_TOKEN environment variable.');
  }

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      port: 443,
      path: apiPath,
      method,
      headers: {
        'User-Agent': 'ForwardEmail-StatusMonitor/1.0',
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          if (res.statusCode >= 400) {
            const error = new Error(`GitHub API error ${res.statusCode}: ${parsed.message || data}`);
            error.statusCode = res.statusCode;

            // Retry on 5xx errors or rate limiting (403/429)
            if (retries > 0 && (res.statusCode >= 500 || res.statusCode === 429 || res.statusCode === 403)) {
              console.log(`GitHub API error ${res.statusCode}, retrying (${retries} retries left)...`);
              setTimeout(() => {
                githubApi(method, apiPath, body, retries - 1).then(resolve).catch(reject);
              }, 2000);
              return;
            }

            reject(error);
          } else {
            resolve(parsed);
          }
        } catch (error) {
          reject(new Error(`Failed to parse GitHub response: ${error.message}`));
        }
      });
    });

    req.on('error', (error) => {
      if (retries > 0) {
        console.log(`GitHub API network error, retrying (${retries} retries left)...`);
        setTimeout(() => {
          githubApi(method, apiPath, body, retries - 1).then(resolve).catch(reject);
        }, 2000);
        return;
      }
      reject(error);
    });

    req.setTimeout(30_000, () => {
      req.destroy();
      const error = new Error('GitHub API timeout');
      if (retries > 0) {
        console.log(`GitHub API timeout, retrying (${retries} retries left)...`);
        setTimeout(() => {
          githubApi(method, apiPath, body, retries - 1).then(resolve).catch(reject);
        }, 2000);
        return;
      }
      reject(error);
    });

    if (body) {
      req.write(JSON.stringify(body));
    }

    req.end();
  });
}

/**
 * Check if a GitHub issue exists and is accessible
 * @param {number} issueNumber - Issue number to check
 * @returns {Promise<object|null>} - Issue data or null if not found
 */
async function getIssue(issueNumber) {
  if (!issueNumber || typeof issueNumber !== 'number') {
    return null;
  }

  try {
    const issue = await githubApi('GET', `/repos/${CONFIG.owner}/${CONFIG.repo}/issues/${issueNumber}`);
    return issue;
  } catch (error) {
    if (error.statusCode === 404) {
      console.log(`Issue #${issueNumber} not found`);
      return null;
    }
    throw error;
  }
}

/**
 * Search for existing issue by incident ID
 * @param {string} incidentId - External incident ID
 * @param {string} provider - Provider name
 * @returns {Promise<object|null>} - Existing issue or null
 */
async function findExistingIssue(incidentId, provider) {
  if (!incidentId || !provider) {
    return null;
  }

  try {
    const searchQuery = encodeURIComponent(
      `repo:${CONFIG.owner}/${CONFIG.repo} is:issue label:maintenance "${provider}" "${incidentId}" in:body`
    );
    const result = await githubApi('GET', `/search/issues?q=${searchQuery}`);

    if (result.items && result.items.length > 0) {
      return result.items[0];
    }
  } catch (error) {
    console.error('Error searching for existing issue:', error.message);
  }

  return null;
}

/**
 * Format an issue title that clearly attributes the incident to an external provider.
 * @param {object} incident - Incident data
 * @returns {string} - External provider incident title
 */
function formatExternalProviderIncidentTitle(incident) {
  const service = typeof incident?.service === 'string' ? incident.service.trim() : '';
  if (!service) {
    throw new TypeError('Incident service must be a non-empty string');
  }

  return `External Provider Incident: ${service}`;
}

/**
 * Update an issue title when it does not clearly attribute the incident to an external provider.
 * @param {number} issueNumber - Issue number
 * @param {object} incident - Incident data
 * @param {object} existingIssue - Existing GitHub issue data
 * @param {Function} request - GitHub API request function
 * @returns {Promise<boolean>} - True when a title update was made
 */
async function updateIssueTitle(issueNumber, incident, existingIssue, request = githubApi) {
  const title = formatExternalProviderIncidentTitle(incident);
  if (existingIssue.title === title) {
    return false;
  }

  await request('PATCH', `/repos/${CONFIG.owner}/${CONFIG.repo}/issues/${issueNumber}`, {
    title
  });
  console.log(`Renamed issue #${issueNumber} to "${title}"`);
  return true;
}

/**
 * Synchronize an issue title without posting a status-update comment.
 * @param {number} issueNumber - Issue number
 * @param {object} incident - Incident data
 * @returns {Promise<boolean>} - True if the issue was found
 */
async function synchronizeIssueTitle(issueNumber, incident) {
  const existingIssue = await getIssue(issueNumber);
  if (!existingIssue) {
    return false;
  }

  await updateIssueTitle(issueNumber, incident, existingIssue);
  return true;
}

/**
 * Create a new GitHub issue for an incident
 * @param {object} incident - Incident data
 * @returns {Promise<object>} - Created issue
 */
async function createIssue(incident) {
  const title = formatExternalProviderIncidentTitle(incident);

  let body = `The external provider **${incident.service}** has reported an incident that may affect email delivery to or from that provider.\n\n`;

  body += `## Incident Details\n\n`;
  body += `| Field | Value |\n`;
  body += `|-------|-------|\n`;
  body += `| **Provider** | ${incident.provider.charAt(0).toUpperCase() + incident.provider.slice(1)} |\n`;
  body += `| **Service** | ${incident.service} |\n`;
  body += `| **Incident ID** | \`${incident.id}\` |\n`;
  body += `| **Status** | ${incident.isResolved ? '✅ Resolved' : '🔴 Active'} |\n`;

  if (incident.startTime) {
    body += `| **Started** | ${incident.startTime} |\n`;
  }

  if (incident.endTime) {
    body += `| **Ended** | ${incident.endTime} |\n`;
  }

  if (incident.duration) {
    body += `| **Duration** | ${incident.duration} |\n`;
  }

  if (incident.usersAffected) {
    body += `| **Impact** | ${incident.usersAffected} |\n`;
  }

  body += `\n## Description\n\n${incident.description || incident.title}\n\n`;

  if (incident.link) {
    body += `## Official Status Page\n\n${incident.link}\n\n`;
  }

  body += `---\n\n`;
  body += `> **Note:** Forward Email users may experience delays when sending to or receiving from ${incident.service} during this incident.\n\n`;
  body += `*This issue was automatically created by the external mail provider monitor.*`;

  const issue = await githubApi('POST', `/repos/${CONFIG.owner}/${CONFIG.repo}/issues`, {
    title,
    body,
    labels: CONFIG.labels
  });

  console.log(`Created issue #${issue.number} for ${incident.service} incident ${incident.id}`);
  return issue;
}

/**
 * Update an existing GitHub issue
 * @param {number} issueNumber - Issue number
 * @param {object} incident - Incident data
 * @param {boolean} shouldClose - Whether to close the issue
 * @returns {Promise<boolean>} - True if update was successful
 */
async function updateIssue(issueNumber, incident, shouldClose = false) {
  // Validate issue number - must be a positive integer
  if (typeof issueNumber !== 'number' || !Number.isInteger(issueNumber) || issueNumber <= 0) {
    console.log(`Invalid issue number: ${issueNumber}, skipping update`);
    return false;
  }

  // Verify the issue exists before trying to update
  const existingIssue = await getIssue(issueNumber);
  if (!existingIssue) {
    console.log(`Issue #${issueNumber} does not exist, skipping update`);
    return false;
  }

  let titleUpdated;
  try {
    // Keep the title clear when an active or resolved incident is revisited.
    titleUpdated = await updateIssueTitle(issueNumber, incident, existingIssue);
  } catch (error) {
    console.error(`Failed to update title for issue #${issueNumber}:`, error.message);
    return false;
  }

  // Check if issue is already closed
  if (existingIssue.state === 'closed' && shouldClose) {
    console.log(`Issue #${issueNumber} is already closed${titleUpdated ? ' and its title was updated' : ''}`);
    return true;
  }

  // Add a comment with the update
  let comment = `## Status Update\n\n`;
  comment += `**Time:** ${new Date().toISOString()}\n`;
  comment += `**Status:** ${incident.isResolved ? '✅ Resolved' : '🔴 Still Active'}\n\n`;

  if (incident.description) {
    comment += `### Latest Update\n\n${incident.description}\n\n`;
  }

  if (incident.duration) {
    comment += `**Total Outage Duration:** ${incident.duration}\n\n`;
  }

  if (incident.isResolved) {
    comment += `---\n\nThe ${incident.service} incident has been resolved.`;
  }

  try {
    await githubApi('POST', `/repos/${CONFIG.owner}/${CONFIG.repo}/issues/${issueNumber}/comments`, {
      body: comment
    });

    if (shouldClose) {
      await githubApi('PATCH', `/repos/${CONFIG.owner}/${CONFIG.repo}/issues/${issueNumber}`, {
        state: 'closed',
        state_reason: 'completed'
      });
      console.log(`Closed issue #${issueNumber} - incident resolved`);
    } else {
      console.log(`Updated issue #${issueNumber} with latest status`);
    }

    return true;
  } catch (error) {
    console.error(`Failed to update issue #${issueNumber}:`, error.message);
    return false;
  }
}

/**
 * Validate state object structure
 * @param {object} state - State object to validate
 * @returns {object} - Validated and sanitized state
 */
function validateState(state) {
  const validState = {
    incidents: {},
    lastRun: null
  };

  if (!state || typeof state !== 'object') {
    return validState;
  }

  validState.lastRun = state.lastRun || null;

  if (state.incidents && typeof state.incidents === 'object') {
    for (const [key, value] of Object.entries(state.incidents)) {
      // Validate each incident entry
      if (value && typeof value === 'object') {
        validState.incidents[key] = {
          issueNumber: typeof value.issueNumber === 'number' ? value.issueNumber : null,
          isResolved: Boolean(value.isResolved),
          createdAt: value.createdAt || null,
          lastUpdate: value.lastUpdate || null,
          resolvedAt: value.resolvedAt || null
        };
      }
    }
  }

  return validState;
}

/**
 * Load previous state from file
 * @returns {object} - Previous state
 */
function loadState() {
  try {
    const statePath = path.join(process.cwd(), CONFIG.stateFile);
    if (fs.existsSync(statePath)) {
      const rawState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      return validateState(rawState);
    }
  } catch (error) {
    console.error('Error loading state:', error.message);
  }

  return { incidents: {}, lastRun: null };
}

/**
 * Save current state to file
 * @param {object} state - State to save
 */
function saveState(state) {
  try {
    const statePath = path.join(process.cwd(), CONFIG.stateFile);
    const validState = validateState(state);
    fs.writeFileSync(statePath, JSON.stringify(validState, null, 2));
  } catch (error) {
    console.error('Error saving state:', error.message);
  }
}

/**
 * Main monitoring function
 */
async function monitor() {
  console.log(`[${new Date().toISOString()}] Starting external mail provider status check...`);

  const state = loadState();
  const allIncidents = [];
  const errors = [];

  // Fetch incidents from all providers with error handling for each
  console.log('Checking Google Workspace status...');
  try {
    const googleIncidents = await parseGoogleFeed();
    allIncidents.push(...googleIncidents);
    console.log(`  Found ${googleIncidents.length} Gmail incident(s)`);
  } catch (error) {
    console.error('  Failed to check Google:', error.message);
    errors.push({ provider: 'google', error: error.message });
  }

  console.log('Checking Apple System Status...');
  try {
    const appleIncidents = await parseAppleFeed();
    allIncidents.push(...appleIncidents);
    console.log(`  Found ${appleIncidents.length} iCloud Mail incident(s)`);
  } catch (error) {
    console.error('  Failed to check Apple:', error.message);
    errors.push({ provider: 'apple', error: error.message });
  }

  console.log('Checking Microsoft Status...');
  try {
    const microsoftIncidents = await parseMicrosoftFeed();
    allIncidents.push(...microsoftIncidents);
    console.log(`  Found ${microsoftIncidents.length} Microsoft incident(s)`);
  } catch (error) {
    console.error('  Failed to check Microsoft:', error.message);
    errors.push({ provider: 'microsoft', error: error.message });
  }

  console.log(`Found ${allIncidents.length} total relevant incident(s)`);

  // Log any errors but continue processing
  if (errors.length > 0) {
    console.log(`Warning: ${errors.length} provider(s) had errors but continuing with available data`);
  }

  // Process each incident
  for (const incident of allIncidents) {
    const stateKey = `${incident.provider}-${incident.id}`;
    const previousState = state.incidents[stateKey];

    try {
      // Check if we've already processed this incident
      if (previousState) {
        // Skip if already resolved in our state
        if (previousState.isResolved) {
          console.log(`Incident ${stateKey} already resolved in state, skipping`);
          continue;
        }

        // If previously active and now resolved, update and close
        if (incident.isResolved) {
          console.log(`Incident ${stateKey} has been resolved`);

          // Only try to update if we have a valid issue number (positive integer)
          if (typeof previousState.issueNumber === 'number' && Number.isInteger(previousState.issueNumber) && previousState.issueNumber > 0) {
            const updated = await updateIssue(previousState.issueNumber, incident, true);
            if (updated) {
              state.incidents[stateKey] = {
                ...previousState,
                isResolved: true,
                resolvedAt: new Date().toISOString()
              };
            }
          } else {
            // No issue number, just mark as resolved in state
            console.log(`No issue number for ${stateKey}, marking as resolved in state only`);
            state.incidents[stateKey] = {
              ...previousState,
              isResolved: true,
              resolvedAt: new Date().toISOString()
            };
          }
        } else {
          // Still active, check if we should update
          const lastUpdate = new Date(previousState.lastUpdate || 0);
          const hoursSinceUpdate = (Date.now() - lastUpdate.getTime()) / (1000 * 60 * 60);

          if (typeof previousState.issueNumber === 'number' && Number.isInteger(previousState.issueNumber) && previousState.issueNumber > 0) {
            await synchronizeIssueTitle(previousState.issueNumber, incident);
          }

          // Update every 2 hours for ongoing incidents
          if (hoursSinceUpdate >= 2 && typeof previousState.issueNumber === 'number' && Number.isInteger(previousState.issueNumber) && previousState.issueNumber > 0) {
            const updated = await updateIssue(previousState.issueNumber, incident, false);
            if (updated) {
              state.incidents[stateKey].lastUpdate = new Date().toISOString();
            }
          }
        }
      } else if (!incident.isResolved) {
        // New active incident - create issue
        console.log(`New incident detected: ${stateKey}`);

        // First check if issue already exists (in case state was lost)
        const existingIssue = await findExistingIssue(incident.id, incident.provider);

        if (existingIssue) {
          console.log(`Found existing issue #${existingIssue.number} for incident ${stateKey}`);
          await updateIssueTitle(existingIssue.number, incident, existingIssue);
          state.incidents[stateKey] = {
            issueNumber: existingIssue.number,
            isResolved: existingIssue.state === 'closed',
            createdAt: existingIssue.created_at,
            lastUpdate: new Date().toISOString()
          };
        } else {
          const issue = await createIssue(incident);
          state.incidents[stateKey] = {
            issueNumber: issue.number,
            isResolved: false,
            createdAt: new Date().toISOString(),
            lastUpdate: new Date().toISOString()
          };
        }
      } else {
        // New incident that's already resolved - just track it without creating an issue
        console.log(`Incident ${stateKey} is already resolved, tracking without creating issue`);
        state.incidents[stateKey] = {
          issueNumber: null,
          isResolved: true,
          createdAt: new Date().toISOString(),
          resolvedAt: new Date().toISOString()
        };
      }
    } catch (error) {
      console.error(`Failed to process incident ${stateKey}:`, error.message);
      // Continue processing other incidents
    }
  }

  // Detect Microsoft incidents that have disappeared from the feed (resolved)
  // Microsoft's feed removes incidents once resolved, so absence = resolution
  const activeMicrosoftIds = new Set(
    allIncidents
      .filter((i) => i.provider === 'microsoft')
      .map((i) => i.id)
  );
  const microsoftFailed = errors.some((e) => e.provider === 'microsoft');

  if (!microsoftFailed) {
    for (const [key, value] of Object.entries(state.incidents)) {
      if (
        key.startsWith('microsoft-') &&
        !value.isResolved &&
        !activeMicrosoftIds.has(key.replace('microsoft-', ''))
      ) {
        console.log(
          `Microsoft incident ${key} no longer in feed, marking as resolved`
        );

        const resolvedIncident = {
          provider: 'microsoft',
          service: 'Outlook.com / Microsoft 365',
          id: key.replace('microsoft-', ''),
          title: 'Outlook.com / Microsoft 365 incident resolved',
          description:
            'This incident is no longer listed in the Microsoft status feed, indicating it has been resolved.',
          isResolved: true
        };

        if (
          typeof value.issueNumber === 'number' &&
          Number.isInteger(value.issueNumber) &&
          value.issueNumber > 0
        ) {
          try {
            const updated = await updateIssue(
              value.issueNumber,
              resolvedIncident,
              true
            );
            if (updated) {
              state.incidents[key] = {
                ...value,
                isResolved: true,
                resolvedAt: new Date().toISOString()
              };
            }
          } catch (error) {
            console.error(
              `Failed to close issue for disappeared Microsoft incident ${key}:`,
              error.message
            );
          }
        } else {
          console.log(
            `No issue number for ${key}, marking as resolved in state only`
          );
          state.incidents[key] = {
            ...value,
            isResolved: true,
            resolvedAt: new Date().toISOString()
          };
        }
      }
    }
  }

  // Clean up old resolved incidents from state (older than 7 days)
  const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
  for (const [key, value] of Object.entries(state.incidents)) {
    if (value.isResolved && new Date(value.resolvedAt || 0).getTime() < sevenDaysAgo) {
      console.log(`Cleaning up old resolved incident: ${key}`);
      delete state.incidents[key];
    }
  }

  state.lastRun = new Date().toISOString();
  saveState(state);

  console.log(`[${new Date().toISOString()}] Status check complete`);

  // Only fail if all providers failed
  if (errors.length === 3) {
    throw new Error('All provider checks failed');
  }
}

if (require.main === module) {
  monitor().catch((error) => {
    console.error('Monitor failed:', error);
    process.exit(1);
  });
}

module.exports = {
  formatExternalProviderIncidentTitle,
  updateIssueTitle
};
