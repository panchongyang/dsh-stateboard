// Run locally and privately. Never paste the bearer or redirect this output into a project workspace.
import { issueSpaceGrant } from '../lib/host/mcp-space-grant.js';
const [spaceRoot, scope, ...rest] = process.argv.slice(2);
if (!spaceRoot || !scope || rest.length) throw new Error('Usage: node scripts/issue-space-grant.mjs ABSOLUTE_SPACE_ROOT metadata|full');
process.stdout.write(JSON.stringify(issueSpaceGrant(spaceRoot, scope)) + '\n');
