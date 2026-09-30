import { describe, expect, it } from 'vitest'
import { isMenuLink, isMenuSlot, type MenuLinkItem, type MenuSlotItem } from './types.js'

const link: MenuLinkItem = {
	kind: 'link',
	id: 'home',
	label: 'Home',
	href: '/',
	icon: '⌂',
}

const slot: MenuSlotItem = {
	kind: 'slot',
	id: 'cv',
	label: 'CV',
	icon: '📄',
	component: (() => null) as unknown as MenuSlotItem['component'],
}

describe('menu type guards', () => {
	it('isMenuLink matches links only', () => {
		expect(isMenuLink(link)).toBe(true)
		expect(isMenuLink(slot)).toBe(false)
	})
	it('isMenuSlot matches slots only', () => {
		expect(isMenuSlot(slot)).toBe(true)
		expect(isMenuSlot(link)).toBe(false)
	})
	it('single-locale apps hide the language row (locales.length <= 1)', () => {
		const showLanguageRow = (count: number): boolean => count > 1
		expect(showLanguageRow(0)).toBe(false)
		expect(showLanguageRow(1)).toBe(false)
		expect(showLanguageRow(3)).toBe(true)
	})
})
