/**
 * Unit tests for the primary-form extractor.
 * Three fixtures: contact form, appointment form, no matching form.
 * Plus edge-case coverage (relative action, http action, hidden fields).
 */
import { describe, it, expect } from 'vitest'
import * as cheerio from 'cheerio'
import { extractPrimaryForm } from './form-extractor.js'

const PAGE = 'https://clinic.example.com/home'

describe('extractPrimaryForm', () => {
  it('detects a contact form via <input type="email">', () => {
    const html = `
      <form action="/submit" method="post">
        <input name="full_name" />
        <input type="email" name="email" />
        <textarea name="message"></textarea>
        <input type="hidden" name="csrf" value="xyz" />
      </form>`
    const summary = extractPrimaryForm(cheerio.load(html), PAGE)
    expect(summary).not.toBeNull()
    expect(summary!.fields).toEqual(['full_name', 'email', 'message'])
    expect(summary!.action).toBe('https://clinic.example.com/submit')
    expect(summary!.hasHttps).toBe(true)
  })

  it('detects an appointment form via a matching label', () => {
    const html = `
      <form action="https://book.example.com/appt">
        <label for="pt_name">Patient name</label>
        <input id="pt_name" />
        <label for="pt_dob">Appointment date</label>
        <input id="pt_dob" type="date" />
      </form>`
    const summary = extractPrimaryForm(cheerio.load(html), PAGE)
    expect(summary).not.toBeNull()
    expect(summary!.fields).toEqual(['pt_name', 'pt_dob'])
    expect(summary!.hasHttps).toBe(true)
  })

  it('detects a form via a phone-like field name', () => {
    const html = `
      <form action="http://insecure.example.com/">
        <input name="first" />
        <input name="phoneNumber" />
      </form>`
    const summary = extractPrimaryForm(cheerio.load(html), PAGE)
    expect(summary).not.toBeNull()
    expect(summary!.fields).toEqual(['first', 'phoneNumber'])
    expect(summary!.hasHttps).toBe(false)
  })

  it('returns null when no form matches the heuristic', () => {
    const html = `
      <form action="/search">
        <input name="q" />
        <button>Go</button>
      </form>`
    const summary = extractPrimaryForm(cheerio.load(html), PAGE)
    expect(summary).toBeNull()
  })

  it('picks the first matching form when multiple forms exist', () => {
    const html = `
      <form action="/newsletter"><input name="q" /></form>
      <form id="primary" action="/contact">
        <input type="email" name="em" />
      </form>
      <form action="/other"><input type="email" name="em2" /></form>`
    const summary = extractPrimaryForm(cheerio.load(html), PAGE)
    expect(summary).not.toBeNull()
    expect(summary!.action).toBe('https://clinic.example.com/contact')
    expect(summary!.fields).toEqual(['em'])
  })

  it('handles empty action by inheriting page protocol', () => {
    const html = `
      <form>
        <input type="email" name="em" />
      </form>`
    const summary = extractPrimaryForm(cheerio.load(html), PAGE)
    expect(summary).not.toBeNull()
    expect(summary!.action).toBe('')
    expect(summary!.hasHttps).toBe(true)
  })
})
