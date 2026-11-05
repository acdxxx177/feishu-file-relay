import assert from 'node:assert/strict'
import { test } from 'node:test'
import { locales, messages, rememberLanguage, requestLanguage, resolveLanguages } from '../../src/browser/i18n.ts'

test('language negotiation walks preferences in order and distinguishes Chinese scripts', () => {
  for (const tag of ['zh', 'ZH-cn', 'zh-SG', 'zh-Hans', 'zh-Hans-TW']) {
    assert.equal(resolveLanguages([tag, 'es']), 'zh-CN', tag)
  }
  for (const tag of ['zh-Hant', 'zh-HK', 'zh-TW', 'zh-MO', 'zh-Hant-CN', 'zh-Latn']) {
    assert.equal(resolveLanguages([tag, 'es-419']), 'es', tag)
  }
  assert.equal(resolveLanguages(['', 'en???', 'de', 'hi-IN', 'es']), 'hi')
  assert.equal(resolveLanguages(['fr', 'en-AU', 'es']), 'en')
  assert.equal(resolveLanguages(['de', 'fr']), 'en')
  assert.equal(resolveLanguages([]), 'en')
})

test('HTML prefers the exact saved locale, then weighted browser choices, then English', () => {
  function language(header: string, cookie = '') {
    return requestLanguage(new Request('https://relay.test/f/test', {
      headers: { 'Accept-Language': header, Cookie: cookie },
    }))
  }
  assert.deepEqual(language('hi;q=0.2, es-AR;q=0.9, zh-Hans;q=0.8'), { locale: 'es', preference: 'auto' })
  assert.deepEqual(language('es;q=0.3, hi;q=0.3'), { locale: 'es', preference: 'auto' })
  assert.deepEqual(language('zh-Hant, es;q=0.3', 'old=x; relay_language=hi; next=a'), { locale: 'hi', preference: 'hi' })
  assert.deepEqual(language('es;q=foo, zh-Hans;q=0, en;q=1.2, hi;q=0.1', 'relay_language=bad'), { locale: 'hi', preference: 'auto' })
  assert.deepEqual(language('fr-FR, *, zh-TW', 'relay_language=auto'), { locale: 'en', preference: 'auto' })
  assert.deepEqual(language('de,'.repeat(1500) + 'hi'), { locale: 'en', preference: 'auto' })
  assert.deepEqual(language('fr,'.repeat(32) + 'hi'), { locale: 'en', preference: 'auto' })
  assert.deepEqual(language('', 'similar_relay_language=es'), { locale: 'en', preference: 'auto' })
})

test('manual preference is host-only and scoped to file pages; automatic clears it', () => {
  const browser = { document: { cookie: '' }, location: { protocol: 'https:' } }
  rememberLanguage('hi', browser)
  assert.match(browser.document.cookie, /^relay_language=hi;/)
  assert.match(browser.document.cookie, /; Path=\/f\/;/)
  assert.match(browser.document.cookie, /; Max-Age=[1-9]\d+/)
  assert.match(browser.document.cookie, /; SameSite=Lax; Secure$/)
  assert.doesNotMatch(browser.document.cookie, /; Domain=/i)
  rememberLanguage('auto', browser)
  assert.match(browser.document.cookie, /^relay_language=;/)
  assert.match(browser.document.cookie, /; Max-Age=0;/)

  const blocked = { document: { set cookie(_value: string) { throw Error('Storage blocked') } } }
  assert.doesNotThrow(() => rememberLanguage('es', blocked))
})

test('every catalog covers all page and transfer messages with localized units and formatters', () => {
  const keys = Object.keys(messages('en')).sort()
  const titles = new Set<string>()
  for (const locale of locales) {
    const m = messages(locale)
    titles.add(m.title)
    assert.deepEqual(Object.keys(m).sort(), keys)
    for (const value of Object.values(m)) {
      if (typeof value === 'string') assert.ok(value.trim())
    }
    assert.equal(m.size(1), new Intl.NumberFormat(locale, { style: 'unit', unit: 'byte', unitDisplay: 'long' }).format(1))
    assert.match(m.size(2 ** 20), /1\sMiB$/)
    assert.equal(m.percent(0.125), new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(0.125))
    assert.notEqual(m.percent(0.99999), m.percent(1))
    assert.match(m.http(502), /502/)
    assert.match(m.retry(15, 2), /15/)
    assert.match(m.retry(15, 2), /2/)
    assert.ok(m.amount(12345678, 90000000).includes(new Intl.NumberFormat(locale).format(12345678)))
    assert.notEqual(m.blobReady, m.saved)
  }
  assert.equal(titles.size, locales.length)
})
