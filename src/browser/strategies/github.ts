/**
 * GitHub strategy — uses GitHub's raw API for fast content extraction.
 * No auth needed for public repos. Much faster than Playwright.
 */

const MAX_TEXT = 30_000;
const GITHUB_API = 'https://api.github.com';

interface BrowseResult {
  ok: boolean;
  url: string;
  title: string;
  text: string;
  length: number;
  links: { text: string; href: string }[];
  strategy_used: string;
  error?: string;
}

/**
 * Extract content from a GitHub URL using the API.
 * Handles: repos, READMEs, issues, pull requests, file views.
 */
export async function browseGitHub(url: string): Promise<BrowseResult> {
  const parsed = parseGitHubUrl(url);
  if (!parsed) {
    return { ok: false, url, title: '', text: '', length: 0, links: [], strategy_used: 'github-api', error: 'Could not parse GitHub URL' };
  }

  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'kamai-browse/0.1',
  };
  // Optional: use GITHUB_TOKEN if available for higher rate limits
  if (process.env.GITHUB_TOKEN) {
    headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  try {
    switch (parsed.type) {
      case 'repo':
        return await fetchRepo(parsed.owner, parsed.repo, url, headers);
      case 'issue':
      case 'pull':
        return await fetchIssue(parsed.owner, parsed.repo, parsed.number!, url, headers);
      case 'file':
        return await fetchFile(parsed.owner, parsed.repo, parsed.path!, parsed.ref, url, headers);
      default:
        return { ok: false, url, title: '', text: '', length: 0, links: [], strategy_used: 'github-api', error: `Unsupported GitHub URL type: ${parsed.type}` };
    }
  } catch (err: any) {
    return { ok: false, url, title: '', text: '', length: 0, links: [], strategy_used: 'github-api', error: `GitHub API error: ${err.message}` };
  }
}

async function fetchRepo(owner: string, repo: string, url: string, headers: Record<string, string>): Promise<BrowseResult> {
  const [repoRes, readmeRes] = await Promise.all([
    fetch(`${GITHUB_API}/repos/${owner}/${repo}`, { headers }),
    fetch(`${GITHUB_API}/repos/${owner}/${repo}/readme`, { headers: { ...headers, Accept: 'application/vnd.github.v3.raw' } }),
  ]);

  if (!repoRes.ok) throw new Error(`Repo not found: ${repoRes.status}`);

  const repoData = await repoRes.json();
  const readmeText = readmeRes.ok ? await readmeRes.text() : '(No README found)';

  const parts: string[] = [];
  parts.push(`Repository: ${repoData.full_name}`);
  parts.push(`Description: ${repoData.description || 'None'}`);
  parts.push(`Stars: ${(repoData.stargazers_count || 0).toLocaleString()} | Forks: ${(repoData.forks_count || 0).toLocaleString()} | Open Issues: ${repoData.open_issues_count || 0}`);
  parts.push(`Language: ${repoData.language || 'Unknown'} | License: ${repoData.license?.spdx_id || 'None'}`);
  parts.push(`Created: ${repoData.created_at?.slice(0, 10)} | Updated: ${repoData.updated_at?.slice(0, 10)}`);
  if (repoData.topics?.length) parts.push(`Topics: ${repoData.topics.join(', ')}`);
  parts.push('');
  parts.push('--- README ---');
  parts.push(readmeText);

  const text = parts.join('\n').slice(0, MAX_TEXT);

  const links = [
    { text: 'Issues', href: `https://github.com/${owner}/${repo}/issues` },
    { text: 'Pull Requests', href: `https://github.com/${owner}/${repo}/pulls` },
    { text: 'Releases', href: `https://github.com/${owner}/${repo}/releases` },
  ];
  if (repoData.homepage) links.push({ text: 'Homepage', href: repoData.homepage });

  return { ok: true, url, title: `${repoData.full_name} — ${repoData.description || 'GitHub'}`, text, length: text.length, links, strategy_used: 'github-api' };
}

async function fetchIssue(owner: string, repo: string, number: number, url: string, headers: Record<string, string>): Promise<BrowseResult> {
  const [issueRes, commentsRes] = await Promise.all([
    fetch(`${GITHUB_API}/repos/${owner}/${repo}/issues/${number}`, { headers }),
    fetch(`${GITHUB_API}/repos/${owner}/${repo}/issues/${number}/comments?per_page=30`, { headers }),
  ]);

  if (!issueRes.ok) throw new Error(`Issue not found: ${issueRes.status}`);

  const issue = await issueRes.json();
  const comments = commentsRes.ok ? (await commentsRes.json()) as any[] : [];

  const parts: string[] = [];
  const isPR = !!issue.pull_request;
  parts.push(`${isPR ? 'Pull Request' : 'Issue'} #${number}: ${issue.title}`);
  parts.push(`State: ${issue.state} | Author: ${issue.user?.login} | Created: ${issue.created_at?.slice(0, 10)}`);
  if (issue.labels?.length) parts.push(`Labels: ${issue.labels.map((l: any) => l.name).join(', ')}`);
  if (issue.assignees?.length) parts.push(`Assignees: ${issue.assignees.map((a: any) => a.login).join(', ')}`);
  parts.push('');
  parts.push(issue.body || '(No description)');

  if (comments.length > 0) {
    parts.push('');
    parts.push(`--- ${comments.length} Comment(s) ---`);
    for (const c of comments) {
      parts.push('');
      parts.push(`@${c.user?.login} (${c.created_at?.slice(0, 10)}):`);
      parts.push(c.body || '');
    }
  }

  const text = parts.join('\n').slice(0, MAX_TEXT);
  return { ok: true, url, title: `#${number}: ${issue.title}`, text, length: text.length, links: [], strategy_used: 'github-api' };
}

async function fetchFile(owner: string, repo: string, path: string, ref: string | undefined, url: string, headers: Record<string, string>): Promise<BrowseResult> {
  const apiUrl = `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}${ref ? `?ref=${ref}` : ''}`;
  const res = await fetch(apiUrl, { headers: { ...headers, Accept: 'application/vnd.github.v3.raw' } });

  if (!res.ok) throw new Error(`File not found: ${res.status}`);

  const text = (await res.text()).slice(0, MAX_TEXT);
  return { ok: true, url, title: `${owner}/${repo}/${path}`, text, length: text.length, links: [], strategy_used: 'github-api' };
}

interface ParsedGitHubUrl {
  owner: string;
  repo: string;
  type: 'repo' | 'issue' | 'pull' | 'file' | 'unknown';
  number?: number;
  path?: string;
  ref?: string;
}

function parseGitHubUrl(url: string): ParsedGitHubUrl | null {
  try {
    const u = new URL(url.startsWith('http') ? url : 'https://' + url);
    if (!u.hostname.includes('github.com')) return null;

    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;

    const [owner, repo, ...rest] = parts;

    if (rest.length === 0) return { owner, repo, type: 'repo' };

    if (rest[0] === 'issues' && rest[1]) return { owner, repo, type: 'issue', number: parseInt(rest[1], 10) };
    if (rest[0] === 'pull' && rest[1]) return { owner, repo, type: 'pull', number: parseInt(rest[1], 10) };

    if (rest[0] === 'blob' || rest[0] === 'tree') {
      const ref = rest[1];
      const path = rest.slice(2).join('/');
      return { owner, repo, type: 'file', path, ref };
    }

    return { owner, repo, type: 'unknown' };
  } catch {
    return null;
  }
}