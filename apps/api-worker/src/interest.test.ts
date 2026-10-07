import { afterEach, describe, expect, it } from 'vitest';
import { pgFirst } from '@uptime/cloudflare/postgres';
import { createControlFixture, type ControlTestFixture } from './testing/control-fixture.js';
import { createAtprotoAuth, type AtprotoClientLike } from './atproto-auth.js';
import { interestList, interestReturnPath, interestSignup, recordInterest } from './interest.js';

const databases: ControlTestFixture[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) await database.close();
});

async function fixture() {
  const database = await createControlFixture();
  databases.push(database);
  const db = database.db;
  const did = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
  const scopes: string[] = [];
  let clock = new Date('2026-10-02T12:00:00.000Z');
  async function signup(handle: string, returnTo = interestReturnPath, tampered = false) {
    let state: string | null = null;
    let used = false;
    const client: AtprotoClientLike = {
      clientMetadata: {},
      jwks: {},
      async authorize(_handle, options) {
        scopes.push(options.scope);
        state = options.state;
        return new URL('https://auth.example/authorize');
      },
      async callback() {
        if (used) throw new Error('state already consumed');
        used = true;
        return { session: { did }, state };
      },
    };
    const auth = createAtprotoAuth({
      db,
      config: {
        publicOrigin: 'https://api.example.com',
        sessionSecret: 's'.repeat(32),
        oauthStorageSecret: 'o'.repeat(32),
        sessionTtlSeconds: 3600,
        cookieSecure: true,
        successPath: '/app',
      },
      now: () => clock,
      createClient: () => client,
      onLogin: async (principal, path) => {
        if (path === interestReturnPath) await recordInterest(db, principal, clock);
      },
    });
    const start = await auth.start(
      new Request('https://api.example.com/api/auth/atproto/start', {
        method: 'POST',
        body: JSON.stringify({ handle, returnTo }),
      }),
    );
    const cookie = start.headers.get('set-cookie')!.split(';')[0]!;
    const request = () =>
      new Request('https://api.example.com/api/auth/atproto/callback', {
        headers: { cookie: tampered ? 'uptime_atproto_login=wrong-browser' : cookie },
      });
    return { response: await auth.callback(request()), replay: () => auth.callback(request()) };
  }
  return {
    database,
    db,
    did,
    scopes,
    signup,
    setClock: (value: string) => {
      clock = new Date(value);
    },
  };
}

describe('interest signup collection', () => {
  it('records verified identity-only OAuth once per DID without creating a workspace', async () => {
    const context = await fixture();
    const first = await context.signup('@alice.bsky.social');
    expect(first.response.status).toBe(303);
    expect(first.response.headers.get('location')).toBe(interestReturnPath);
    expect(context.scopes).toEqual(['atproto']);
    expect(await interestSignup(context.db, context.did)).toEqual({
      did: context.did,
      handle: 'alice.bsky.social',
      createdAt: '2026-10-02T12:00:00.000Z',
      updatedAt: '2026-10-02T12:00:00.000Z',
    });
    context.setClock('2026-10-03T12:00:00.000Z');
    await context.signup('alice.new.test');
    expect(await interestList(context.db)).toMatchObject({
      total: 1,
      signups: [
        {
          handle: 'alice.new.test',
          createdAt: '2026-10-02T12:00:00.000Z',
          updatedAt: '2026-10-03T12:00:00.000Z',
        },
      ],
    });
    expect(
      await pgFirst(
        context.db,
        `SELECT count(*)::integer AS count FROM ${context.db.table('workspaces')}`,
      ),
    ).toEqual({
      count: 0,
    });
    expect(
      await pgFirst(
        context.db,
        `SELECT count(*)::integer AS count FROM ${context.db.table('users')}`,
      ),
    ).toEqual({
      count: 0,
    });
    expect((await first.replay()).headers.get('location')).toContain('auth_error');
    expect((await interestList(context.db)).total).toBe(1);
  });

  it('does not collect failed, browser-mismatched, or ordinary application logins', async () => {
    const context = await fixture();
    const mismatch = await context.signup('alice.bsky.social', interestReturnPath, true);
    expect(mismatch.response.headers.get('location')).toContain('auth_error');
    await context.signup('alice.bsky.social', '/app');
    await context.signup('alice.bsky.social', 'https://attacker.example/?interest=joined');
    expect(await interestSignup(context.db, context.did)).toBeNull();
    expect(await interestList(context.db)).toEqual({ total: 0, signups: [] });
  });
});
