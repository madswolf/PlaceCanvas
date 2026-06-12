import app from './../../app.js';
import config from './../../config.js';
import Helper_class from './../../libs/helpers.js';

var instance = null;

const LS_ACCESS_TOKEN  = 'pc_access_token';
const LS_REFRESH_TOKEN = 'pc_refresh_token';
const LS_TOKEN_EXPIRY  = 'pc_token_expiry';

function esc(s) {
	return String(s == null ? 'n/a' : s)
		.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

class Help_debug_info_class {

	constructor() {
		if (instance) return instance;
		instance = this;

		this.Helper = new Helper_class();
		this.set_events();
	}

	set_events() {
		document.addEventListener('keydown', (event) => {
			if (this.Helper.is_input(event.target)) return;
			if (event.key.toLowerCase() === 'p') {
				this.toggle();
				event.preventDefault();
			}
		}, false);
	}

	toggle() {
		const el = document.getElementById('place_debug_info');
		if (!el) return;

		if (el.style.display !== 'none') {
			el.style.display = 'none';
			return;
		}

		const place     = app.PlaceIntegration;
		const expiryMs  = parseInt(localStorage.getItem(LS_TOKEN_EXPIRY) || '0', 10);
		const hasAccess  = !!localStorage.getItem(LS_ACCESS_TOKEN);
		const hasRefresh = !!localStorage.getItem(LS_REFRESH_TOKEN);
		const expiryStr  = expiryMs
			? new Date(expiryMs).toLocaleString() + (Date.now() > expiryMs ? ' (expired)' : '')
			: 'n/a';

		el.innerHTML = `
			<hr class="place_debug_divider">
			<span class="label">API URL:</span> ${esc(place.api_url)}<br>
			<span class="label">Media Host:</span> ${esc(place.media_host)}<br>
			<span class="label">Place ID:</span> ${esc(place.place_id)}<br>
			<span class="label">EXIF File:</span> ${esc(place.filename)}<br>
			<span class="label">Base Layer:</span> ${esc(place.base_layer_id)}<br>
			<span class="label">Canvas:</span> ${esc(config.WIDTH)} &times; ${esc(config.HEIGHT)} px<br>
			<span class="label">Layers:</span> ${esc(config.layers.length)}<br>
			<hr class="place_debug_divider">
			<span class="label">Access Token:</span> ${hasAccess ? 'stored' : 'missing'}<br>
			<span class="label">Refresh Token:</span> ${hasRefresh ? 'stored' : 'missing'}<br>
			<span class="label">Expiry:</span> ${esc(expiryStr)}<br>
		`;
		el.style.display = '';
	}
}

export default Help_debug_info_class;
