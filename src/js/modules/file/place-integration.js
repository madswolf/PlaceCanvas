import app from './../../app.js';
import config from './../../config.js';
import Base_layers_class from './../../core/base-layers.js';
import alertify from './../../../../node_modules/alertifyjs/build/alertify.min.js';

var instance = null;

// localStorage keys — only tokens are dynamic; api/place are baked in at build time
const LS_ACCESS_TOKEN  = 'pc_access_token';
const LS_REFRESH_TOKEN = 'pc_refresh_token';
const LS_TOKEN_EXPIRY  = 'pc_token_expiry'; // Unix ms when access token expires

class Place_integration_class {
	constructor() {
		if (instance) return instance;
		instance = this;

		this.Base_layers = new Base_layers_class();
		this.api_url = null;
		this.media_host = null;
		this.place_id = null;
		this.base_layer_id = null;
		this.filename = null;
		this.refetch_interval_id = null;
		this.refresh_timer_id = null;
	}

	// ── Initialisation ─────────────────────────────────────────────────────────

	async init() {
		const params = new URLSearchParams(window.location.search);

		// .env values are the defaults; URL params override them at runtime.
		const envApiUrl    = typeof PLACE_API_URL    !== 'undefined' ? PLACE_API_URL    : '';
		const envPlaceId   = typeof PLACE_ID         !== 'undefined' ? PLACE_ID         : '';
		const envMediaHost = typeof PLACE_MEDIA_HOST !== 'undefined' ? PLACE_MEDIA_HOST : '';

		this.api_url    = (params.get('apiUrl')    || envApiUrl).replace(/\/$/, '');
		this.media_host = (params.get('mediaHost') || envMediaHost).replace(/\/$/, '');
		this.place_id   =  params.get('placeId')   || envPlaceId;

		await this.init_auth(params);

		// Strip the temp password from the visible URL after use
		if (params.get('tempPassword')) {
			const clean = new URLSearchParams(params);
			clean.delete('tempPassword');
			const qs = clean.toString();
			history.replaceState(null, '', qs ? '?' + qs : window.location.pathname);
		}

		this.add_submit_button();

		if (this.api_url && this.media_host && this.place_id) {
			this.load_place_image();
			this.start_periodic_refetch(30000);
		} else {
			alertify.message('Configure PLACE_API_URL, PLACE_MEDIA_HOST and PLACE_ID in .env and rebuild.');
		}
	}

	// ── Auth ───────────────────────────────────────────────────────────────────

	async init_auth(params) {
		const tempPassword = params.get('tempPassword');

		if (tempPassword && this.api_url) {
			try {
				await this.login_with_temp_password(tempPassword);
				return;
			} catch (e) {
				alertify.error('Login failed: ' + e.message);
			}
		}

		// Restore session from localStorage, refreshing if the access token has expired
		const storedExpiry = parseInt(localStorage.getItem(LS_TOKEN_EXPIRY) || '0', 10);
		if (storedExpiry && Date.now() < storedExpiry && localStorage.getItem(LS_REFRESH_TOKEN)) {
			this.schedule_token_refresh(storedExpiry);
		} else if (localStorage.getItem(LS_REFRESH_TOKEN)) {
			try {
				await this.refresh_tokens();
			} catch (e) {
				this.clear_tokens();
			}
		}
	}

	async login_with_temp_password(tempPassword) {
		const body = new URLSearchParams({ temporary_password: tempPassword });
		const resp = await fetch(`${this.api_url}/auth/login`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: body.toString(),
		});
		if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
		const data = await resp.json();
		this.store_tokens(data);
	}

	async refresh_tokens() {
		const refreshToken = localStorage.getItem(LS_REFRESH_TOKEN);
		if (!refreshToken) throw new Error('No refresh token available');

		const body = new URLSearchParams({ refresh_token: refreshToken });
		const resp = await fetch(`${this.api_url}/auth/refresh`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: body.toString(),
		});
		if (!resp.ok) {
			this.clear_tokens();
			throw new Error(`Token refresh failed: HTTP ${resp.status}`);
		}
		const data = await resp.json();
		this.store_tokens(data);
	}

	store_tokens(tokenResponse) {
		// tokenResponse shape: { access_token, refresh_token, expires_in, token_type }
		const accessToken  = tokenResponse.access_token;
		const refreshToken = tokenResponse.refresh_token;
		const expiresIn    = tokenResponse.expires_in; // seconds

		localStorage.setItem(LS_ACCESS_TOKEN, accessToken);
		if (refreshToken) localStorage.setItem(LS_REFRESH_TOKEN, refreshToken);

		if (expiresIn) {
			const expiresAt = Date.now() + expiresIn * 1000;
			localStorage.setItem(LS_TOKEN_EXPIRY, String(expiresAt));
			this.schedule_token_refresh(expiresAt);
		}
	}

	clear_tokens() {
		localStorage.removeItem(LS_ACCESS_TOKEN);
		localStorage.removeItem(LS_REFRESH_TOKEN);
		localStorage.removeItem(LS_TOKEN_EXPIRY);
		if (this.refresh_timer_id) {
			clearTimeout(this.refresh_timer_id);
			this.refresh_timer_id = null;
		}
	}

	schedule_token_refresh(expiresAtMs) {
		if (this.refresh_timer_id) clearTimeout(this.refresh_timer_id);
		// Refresh 30 seconds before expiry (or immediately if already close)
		const delay = Math.max(0, expiresAtMs - Date.now() - 30_000);
		this.refresh_timer_id = setTimeout(async () => {
			try {
				await this.refresh_tokens();
			} catch (e) {
				console.warn('Proactive token refresh failed:', e.message);
			}
		}, delay);
	}

	// Returns a valid access token, refreshing first if it is near/past expiry.
	async get_valid_access_token() {
		const expiry = parseInt(localStorage.getItem(LS_TOKEN_EXPIRY) || '0', 10);
		const needsRefresh = expiry && Date.now() >= expiry - 10_000; // within 10 s of expiry

		if (needsRefresh && localStorage.getItem(LS_REFRESH_TOKEN)) {
			await this.refresh_tokens();
		}

		return localStorage.getItem(LS_ACCESS_TOKEN) || null;
	}

	// ── UI ─────────────────────────────────────────────────────────────────────

	add_submit_button() {
		const submenu = document.querySelector('.submenu');
		if (!submenu) return;

		const btn = document.createElement('button');
		btn.id = 'submit_place_button';
		btn.type = 'button';
		btn.className = 'submit_place_button';
		btn.textContent = 'Submit to Place';
		btn.addEventListener('click', () => this.submit());
		submenu.appendChild(btn);
	}

	// ── Place image loading ────────────────────────────────────────────────────

	async load_place_image() {
		if (!this.media_host || !this.place_id) return;

		try {
			const imgResp = await fetch(`${this.media_host}/places/${this.place_id}_latest.png`);
			if (imgResp.status === 404) return; // no image yet
			if (!imgResp.ok) throw new Error(`HTTP ${imgResp.status}`);

			const imgBuffer = await imgResp.arrayBuffer();
			this.filename = this.read_exif_filename(imgBuffer) || 'place_submission';

			const blob   = new Blob([imgBuffer]);
			const dataUrl = await this.blob_to_data_url(blob);

			const existingBase = config.layers.find(l => l.id === this.base_layer_id);
			if (this.base_layer_id !== null && existingBase) {
				this.update_base_layer_image(existingBase, dataUrl);
			} else {
				await this.insert_base_layer(dataUrl);
			}
		} catch (e) {
			alertify.error('Failed to load place image: ' + e.message);
			console.error(e);
		}
	}

	async insert_base_layer(dataUrl) {
		await app.State.do_action(
			new app.Actions.Insert_layer_action({
				name: 'Place Image',
				type: 'image',
				data: dataUrl,
				locked: true,
			}, true)
		);

		const baseLayer = config.layer;
		this.base_layer_id = baseLayer.id;
		baseLayer.locked = true;

		// Keep base layer below all others
		const minOrder = Math.min(...config.layers.map(l => l.order));
		baseLayer.order = minOrder - 1;

		// Add a blank paint layer above it for the user
		await app.State.do_action(
			new app.Actions.Insert_layer_action({ name: 'Paint Layer' })
		);

		app.Layers.render();
		app.GUI.GUI_layers.render_layers();
	}

	update_base_layer_image(layer, dataUrl) {
		const img = new Image();
		img.crossOrigin = 'Anonymous';
		img.onload = () => {
			layer.link = img;
			layer.width = img.width;
			layer.height = img.height;
			config.need_render = true;
			app.GUI.GUI_layers.render_layers();
		};
		img.src = dataUrl;
	}

	start_periodic_refetch(intervalMs) {
		if (this.refetch_interval_id) clearInterval(this.refetch_interval_id);
		this.refetch_interval_id = setInterval(() => this.load_place_image(), intervalMs);
	}

	// ── Submission ─────────────────────────────────────────────────────────────

	async get_pixel_price() {
		const resp = await fetch(`${this.api_url}/MemePlaces/${this.place_id}/currentprice`);
		if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
		return resp.json();
	}

	calculate_pixel_changes() {
		if (this.base_layer_id === null) return 0;

		const fullCanvas = document.createElement('canvas');
		fullCanvas.width  = config.WIDTH;
		fullCanvas.height = config.HEIGHT;
		const fullCtx = fullCanvas.getContext('2d');
		app.Layers.convert_layers_to_canvas(fullCtx);

		const baseCanvas = document.createElement('canvas');
		baseCanvas.width  = config.WIDTH;
		baseCanvas.height = config.HEIGHT;
		const baseCtx = baseCanvas.getContext('2d');
		app.Layers.convert_layers_to_canvas(baseCtx, this.base_layer_id);

		const fullData = fullCtx.getImageData(0, 0, config.WIDTH, config.HEIGHT).data;
		const baseData = baseCtx.getImageData(0, 0, config.WIDTH, config.HEIGHT).data;

		let changed = 0;
		for (let i = 0; i < fullData.length; i += 4) {
			if (fullData[i]     !== baseData[i]     ||
				fullData[i + 1] !== baseData[i + 1] ||
				fullData[i + 2] !== baseData[i + 2] ||
				fullData[i + 3] !== baseData[i + 3]) {
				changed++;
			}
		}
		return changed;
	}

	async submit() {
		if (!this.api_url || !this.place_id) {
			alertify.error('Place API not configured. Add ?apiUrl=...&placeId=... to the URL.');
			return;
		}

		let accessToken = await this.get_valid_access_token();
		if (!accessToken) {
			alertify.error('Not authenticated. Reload the page with ?tempPassword=... to log in.');
			return;
		}

		try {
			const priceData     = await this.get_pixel_price();
			const pricePerPixel = priceData.pricePerPixel;
			const changedPixels = this.calculate_pixel_changes();

			if (changedPixels === 0) {
				alertify.message('No pixel changes detected.');
				return;
			}

			const totalCost = (changedPixels * pricePerPixel).toFixed(4);
			alertify.confirm(
				`Submit ${changedPixels.toLocaleString()} changed pixel(s) for ${totalCost} tokens?`,
				() => { this.do_submit(); },
				() => {}
			);
		} catch (e) {
			alertify.error('Failed to prepare submission: ' + e.message);
			console.error(e);
		}
	}

	async do_submit() {
		try {
			const exportCanvas = document.createElement('canvas');
			exportCanvas.width  = config.WIDTH;
			exportCanvas.height = config.HEIGHT;
			const exportCtx = exportCanvas.getContext('2d');
			app.Layers.convert_layers_to_canvas(exportCtx);

			const blob     = await new Promise(resolve => exportCanvas.toBlob(resolve, 'image/png'));
			const safeName = (this.filename || 'place_submission').replace(/\0/g, '').trim();
			const filename = safeName.endsWith('.png') ? safeName : safeName + '.png';

			const formData = new FormData();
			formData.append('ImageWithChanges', blob, filename);
			formData.append('PlaceId', this.place_id);

			const resp = await this.authed_fetch(`${this.api_url}/MemePlaces/submissions/submit`, {
				method: 'POST',
				body: formData,
			});

			if (!resp.ok) {
				const text = await resp.text();
				throw new Error(`HTTP ${resp.status}: ${text}`);
			}

			const result = await resp.json();
			alertify.success(`Submitted! ${result.pixelChangeCount.toLocaleString()} pixels changed.`);
			setTimeout(() => this.load_place_image(), 3000);
		} catch (e) {
			alertify.error('Submission failed: ' + e.message);
			console.error(e);
		}
	}

	// Performs a fetch with the current access token, retrying once after a
	// token refresh if the server responds 401.
	async authed_fetch(url, options = {}) {
		const token = await this.get_valid_access_token();
		const headers = { ...(options.headers || {}), 'Authorization': `Bearer ${token}` };

		let resp = await fetch(url, { ...options, headers });

		if (resp.status === 401 && localStorage.getItem(LS_REFRESH_TOKEN)) {
			try {
				await this.refresh_tokens();
				const newToken = localStorage.getItem(LS_ACCESS_TOKEN);
				headers['Authorization'] = `Bearer ${newToken}`;
				resp = await fetch(url, { ...options, headers });
			} catch (_) {
				this.clear_tokens();
				throw new Error('Session expired – please reload with a new ?tempPassword=...');
			}
		}

		return resp;
	}

	// ── Helpers ────────────────────────────────────────────────────────────────

	blob_to_data_url(blob) {
		return new Promise(resolve => {
			const reader = new FileReader();
			reader.onload = e => resolve(e.target.result);
			reader.readAsDataURL(blob);
		});
	}

	// ── EXIF UserComment reader ────────────────────────────────────────────────

	read_exif_filename(arrayBuffer) {
		try {
			const bytes = new Uint8Array(arrayBuffer);
			const view  = new DataView(arrayBuffer);
			// JPEG: FF D8
			if (bytes[0] === 0xFF && bytes[1] === 0xD8) {
				return this.read_jpeg_exif_comment(view, bytes);
			}
			// PNG: 89 50 4E 47
			if (bytes[0] === 0x89 && bytes[1] === 0x50) {
				return this.read_png_exif_comment(view, bytes);
			}
		} catch (e) {
			console.warn('EXIF read error:', e);
		}
		return null;
	}

	read_jpeg_exif_comment(view, bytes) {
		let pos = 2;
		while (pos + 4 <= bytes.length) {
			if (bytes[pos] !== 0xFF) break;
			const marker = bytes[pos + 1];
			const segLen = view.getUint16(pos + 2, false);
			if (marker === 0xE1 && pos + 10 <= bytes.length) {
				// "Exif\0\0"
				if (bytes[pos + 4] === 0x45 && bytes[pos + 5] === 0x78 &&
					bytes[pos + 6] === 0x69 && bytes[pos + 7] === 0x66 &&
					bytes[pos + 8] === 0x00 && bytes[pos + 9] === 0x00) {
					return this.parse_tiff_user_comment(view, bytes, pos + 10);
				}
			}
			pos += 2 + segLen;
		}
		return null;
	}

	read_png_exif_comment(view, bytes) {
		let pos = 8; // skip PNG signature
		while (pos + 12 <= bytes.length) {
			const chunkLen = view.getUint32(pos, false);
			const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
			if (type === 'eXIf') {
				return this.parse_tiff_user_comment(view, bytes, pos + 8);
			}
			pos += 12 + chunkLen;
		}
		return null;
	}

	parse_tiff_user_comment(view, bytes, tiffStart) {
		if (tiffStart + 8 > bytes.length) return null;
		const byteOrder = view.getUint16(tiffStart, false);
		const le = byteOrder === 0x4949; // 'II' = little-endian
		const ifd0Offset = view.getUint32(tiffStart + 4, le);
		const ifd0Start  = tiffStart + ifd0Offset;

		let comment = this.scan_ifd_for_comment(view, bytes, tiffStart, ifd0Start, le);
		if (comment !== null) return comment;

		// EXIF SubIFD (tag 0x8769)
		const exifPtr = this.find_ifd_tag_value(view, bytes, ifd0Start, le, 0x8769);
		if (exifPtr !== null) {
			comment = this.scan_ifd_for_comment(view, bytes, tiffStart, tiffStart + exifPtr, le);
		}
		return comment;
	}

	scan_ifd_for_comment(view, bytes, tiffStart, ifdStart, le) {
		if (ifdStart + 2 > bytes.length) return null;
		const entryCount = view.getUint16(ifdStart, le);
		for (let i = 0; i < entryCount; i++) {
			const off = ifdStart + 2 + i * 12;
			if (off + 12 > bytes.length) break;
			const tag = view.getUint16(off, le);
			if (tag === 0x9286) { // UserComment
				const byteCount = view.getUint32(off + 4, le);
				const valStart  = byteCount > 4
					? tiffStart + view.getUint32(off + 8, le)
					: off + 8;

				const charset = new TextDecoder('ascii')
					.decode(bytes.slice(valStart, valStart + 8))
					.replace(/\0/g, '').trim();

				const data = bytes.slice(valStart + 8, valStart + byteCount);
				const text = charset === 'UNICODE'
					? new TextDecoder('utf-16le').decode(data)
					: new TextDecoder('utf-8').decode(data);

				const result = text.replace(/\0/g, '').trim();
				return result || null;
			}
		}
		return null;
	}

	find_ifd_tag_value(view, bytes, ifdStart, le, tagId) {
		if (ifdStart + 2 > bytes.length) return null;
		const entryCount = view.getUint16(ifdStart, le);
		for (let i = 0; i < entryCount; i++) {
			const off = ifdStart + 2 + i * 12;
			if (off + 12 > bytes.length) break;
			if (view.getUint16(off, le) === tagId) {
				return view.getUint32(off + 8, le);
			}
		}
		return null;
	}
}

export default Place_integration_class;
