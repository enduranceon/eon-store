import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { normalizeSnapshot } from '../domain.mjs'
import { publicPerson, normalizeSearch } from '../db.mjs'

const read = name => JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url)))
const data = normalizeSnapshot(read('synthetic-snapshot'), read('synthetic-manifest'))
const people = data.people.map(publicPerson)
const summary = { ...data.summary, asOf: data.asOf, people: data.summary.totalPeople,
  onLeave: data.summary.commercialOnLeave, needsAthleteProfile: data.summary.newAthleteProfiles }

async function fixtureApi(page, { failList = false, many = false } = {}) {
  const rows = many ? [...people, ...Array.from({ length: 30 }, (_, i) => ({
    ...people[0], id: `00000000-0000-4000-a000-${String(900 + i).padStart(12, '0')}`,
    name: `Cadastro sintético adicional ${String(i).padStart(2, '0')}`,
  }))] : people
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/summary') return route.fulfill({ json: summary })
    if (url.pathname === '/api/people') {
      if (failList) return route.fulfill({ status: 503, json: { error: 'Falha fictícia' } })
      const query = normalizeSearch(url.searchParams.get('q') || '')
      const category = url.searchParams.get('category')
      const status = url.searchParams.get('sportsStatus')
      const filtered = rows.filter(p => normalizeSearch(p.name).includes(query)
        && (!category || p.category === category) && (!status || p.sportsStatus === status))
      const pageNumber = Number(url.searchParams.get('page') || 1)
      const limit = Number(url.searchParams.get('limit') || 25)
      return route.fulfill({ json: { items: filtered.slice((pageNumber - 1) * limit, pageNumber * limit), total: filtered.length, page: pageNumber, limit } })
    }
    return route.fulfill({ json: rows.find(p => p.id === url.pathname.split('/').at(-1)) })
  })
}

test('searches, separates free membership from coach role and restores keyboard focus', async ({ page }) => {
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await fixtureApi(page)
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Pessoas.' })).toBeVisible()
  await expect(page.locator('.metric').filter({ hasText: 'Alunos ativos' }).locator('strong')).toHaveText('4')
  await page.getByLabel('Vínculo', { exact: true }).selectOption('team')
  await expect(page.locator('tbody tr')).toHaveCount(2)
  await page.getByLabel('Buscar pessoa pelo nome').fill('iris')
  await expect(page.locator('tbody tr')).toHaveCount(1)
  const open = page.getByRole('button', { name: 'Ver detalhes de Atleta Íris Fictícia', exact: true })
  await open.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: 'Atleta Íris Fictícia' })).toBeVisible()
  await expect(dialog.getByText('Fora da contagem de alunos ativos', { exact: true })).toBeVisible()
  await expect(dialog.locator('.badges')).not.toContainText('Coach')
  await expect(dialog).toContainText('sem cobrança')
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
  await expect(open).toBeFocused()
  await page.getByLabel('Buscar pessoa pelo nome').fill('ninguém fictício')
  await expect(page.getByRole('heading', { name: 'Nenhuma pessoa encontrada' })).toBeVisible()
  await page.getByRole('button', { name: 'Limpar filtros', exact: true }).first().click()
  await expect(page.locator('tbody tr')).toHaveCount(people.length)
  expect(errors).toEqual([])
})

test('paginates and resets the page when changing filters', async ({ page }) => {
  await fixtureApi(page, { many: true })
  await page.goto('/')
  await expect(page.locator('tbody tr')).toHaveCount(25)
  await page.getByRole('button', { name: 'Próxima página' }).click()
  await expect(page.locator('.pagination')).toContainText('Página 2 de 2')
  await page.getByLabel('Vínculo', { exact: true }).selectOption('review')
  await expect(page.locator('.pagination')).toContainText('Página 1 de 1')
  await expect(page.getByRole('button', { name: 'Página anterior' })).toBeDisabled()
})

test('shows a service failure and recovers by retrying', async ({ page }) => {
  await fixtureApi(page, { failList: true })
  await page.goto('/')
  await expect(page.getByRole('alert')).toContainText('indisponível')
  await page.unroute('**/api/**')
  await fixtureApi(page)
  await page.getByRole('button', { name: 'Tentar novamente' }).click()
  await expect(page.locator('tbody tr')).toHaveCount(people.length)
})

test('keeps mobile filters and detail readable without page overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await fixtureApi(page)
  await page.goto('/')
  await page.getByLabel('Buscar pessoa pelo nome').fill('Aurora')
  await expect(page.locator('tbody tr')).toHaveCount(1)
  await page.locator('.person-link').click()
  await expect(page.getByRole('dialog')).toContainText('Histórico associado')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.getByRole('button', { name: 'Fechar detalhes' }).click()
  await expect(page.getByRole('dialog')).not.toBeVisible()
})
