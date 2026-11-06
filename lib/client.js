// Browser half of dsh-phone: a "Phone" entry in the dsh web sidebar (the same seat the Plugins and
// Automations entries use) whose page is the pairing page served by this plugin's host half.
// Hand-written in the module format dsh loads (see @deepseek-ai/dsh-client-modules), so there is no build step.
window.__ModuleLoader__.load({
	id: 'dsh-phone',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
		const react = require('react')
		const h = react.createElement
		const NS = 'opentandem.phone'
		const PANEL_ID = 'opentandem-phone'
		const zh = { panel: '手机连接' }
		const en = { panel: 'Phone' }

		// A phone outline, drawn with the current text colour like the other sidebar icons.
		function PhoneIcon({ size }) {
			return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
				h('rect', { x: 7, y: 2.5, width: 10, height: 19, rx: 2.2 }),
				h('path', { d: 'M11 18.5h2' }))
		}
		function PhonePage() {
			return h('iframe', { src: '/opentandem', title: 'OpenTandem', style: { width: '100%', height: '100%', border: 0, display: 'block', background: 'transparent' } })
		}

		const inject = ['slots', 'locale']
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'opentandem-phone: dictionaries')
			const t = ctx.locale.bind(NS)
			ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => ({}) }, PhonePage))
			ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 20, locale: NS, label: () => t('panel') }, PhoneIcon))
		}
		exports.apply = apply
		exports.inject = inject
		return module.exports
	},
})
