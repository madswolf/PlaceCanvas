import app from './../../app.js';
import config from './../../config.js';
import Base_layers_class from './../../core/base-layers.js';
import Helper_class from './../../libs/helpers.js';
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
		this.Helper = new Helper_class();
		this.api_url = null;
		this.media_host = null;
		this.place_id = null;
		this.base_layer_id = null;
		this.filename = null;
		this.refetch_interval_id = null;
		this.refresh_timer_id = null;
		this.reference_image_data = null; // last-fetched server pixels, used for delta refresh
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

		document.addEventListener('keydown', (event) => {
			if (this.Helper.is_input(event.target)) return;
			if (event.keyCode === 82 && !event.ctrlKey && !event.metaKey) {
				this.load_place_image();
				event.preventDefault();
			}
		}, false);

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
				await this.update_base_layer_image(existingBase, dataUrl);
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
			}, true)
		);

		const baseLayer = config.layer;
		this.base_layer_id = baseLayer.id;

		// Store the initial server pixels as the reference for future delta refreshes
		this.reference_image_data = await this.decode_to_image_data(dataUrl);

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

	async update_base_layer_image(layer, dataUrl) {
		const newRef = await this.decode_to_image_data(dataUrl);
		const oldRef = this.reference_image_data;

		// No prior reference or canvas dimensions changed: direct replace, no delta layer
		if (!oldRef || !layer.link
				|| oldRef.width  !== newRef.width
				|| oldRef.height !== newRef.height) {
			this.reference_image_data = newRef;
			this.set_layer_from_image_data(layer, newRef);
			return;
		}

		if (this.has_base_layer_been_edited(layer)) {
			// Preserve the user's edits as a new layer before the base is overwritten
			const userEdits = this.create_user_edits_image_data(layer, oldRef);
			if (this.image_data_has_content(userEdits)) {
				await this.insert_image_data_layer(userEdits, 'Base Edits');
			}

			// Surface server-side changes as a separate layer too
			const serverDelta = this.create_delta_image_data(oldRef, newRef);
			if (this.image_data_has_content(serverDelta)) {
				await this.insert_image_data_layer(serverDelta, 'Place Update');
			}
		}

		// Refresh the base layer with the clean new server image
		this.reference_image_data = newRef;
		this.set_layer_from_image_data(layer, newRef);
	}

	// Returns true when the base layer's current pixels differ from the reference.
	has_base_layer_been_edited(layer) {
		if (!this.reference_image_data || !layer.link) return false;

		const canvas = document.createElement('canvas');
		canvas.width  = layer.width;
		canvas.height = layer.height;
		canvas.getContext('2d').drawImage(layer.link, 0, 0);
		const current = canvas.getContext('2d').getImageData(0, 0, layer.width, layer.height);

		const ref = this.reference_image_data;
		if (current.width !== ref.width || current.height !== ref.height) return true;

		const curD = current.data;
		const refD = ref.data;
		for (let i = 0; i < curD.length; i++) {
			if (curD[i] !== refD[i]) return true;
		}
		return false;
	}

	// Builds an ImageData containing only the pixels the user changed relative to
	// the server reference; unchanged pixels are left fully transparent.
	create_user_edits_image_data(layer, reference) {
		const canvas = document.createElement('canvas');
		canvas.width  = layer.width;
		canvas.height = layer.height;
		canvas.getContext('2d').drawImage(layer.link, 0, 0);
		const current = canvas.getContext('2d').getImageData(0, 0, layer.width, layer.height);

		const result = new ImageData(current.width, current.height);
		const res = result.data;
		const cur = current.data;
		const ref = reference.data;
		for (let i = 0; i < cur.length; i += 4) {
			if (cur[i] !== ref[i] || cur[i+1] !== ref[i+1] || cur[i+2] !== ref[i+2] || cur[i+3] !== ref[i+3]) {
				res[i]   = cur[i];
				res[i+1] = cur[i+1];
				res[i+2] = cur[i+2];
				res[i+3] = cur[i+3];
			}
			// else: transparent (ImageData default)
		}
		return result;
	}

	// Builds an ImageData where pixels that changed between oldRef and newRef carry
	// the new server colour; unchanged pixels are fully transparent.
	create_delta_image_data(oldRef, newRef) {
		const result = new ImageData(newRef.width, newRef.height);
		const res = result.data;
		const old = oldRef.data;
		const nw  = newRef.data;
		for (let i = 0; i < nw.length; i += 4) {
			if (nw[i] !== old[i] || nw[i+1] !== old[i+1] || nw[i+2] !== old[i+2] || nw[i+3] !== old[i+3]) {
				res[i]   = nw[i];
				res[i+1] = nw[i+1];
				res[i+2] = nw[i+2];
				res[i+3] = nw[i+3];
			}
			// else: transparent (ImageData default)
		}
		return result;
	}

	// Returns true if any pixel in imageData has a non-zero alpha channel.
	image_data_has_content(imageData) {
		const data = imageData.data;
		for (let i = 3; i < data.length; i += 4) {
			if (data[i] > 0) return true;
		}
		return false;
	}

	// Inserts a new named image layer above the current layer stack.
	async insert_image_data_layer(imageData, name) {
		const canvas = document.createElement('canvas');
		canvas.width  = imageData.width;
		canvas.height = imageData.height;
		canvas.getContext('2d').putImageData(imageData, 0, 0);

		await app.State.do_action(
			new app.Actions.Insert_layer_action({
				name,
				type: 'image',
				data: canvas.toDataURL('image/png'),
			})
		);

		app.GUI.GUI_layers.render_layers();
	}

	// Decode a data URL into an ImageData via an offscreen canvas.
	decode_to_image_data(dataUrl) {
		return new Promise((resolve, reject) => {
			const img = new Image();
			img.onload = () => {
				const canvas = document.createElement('canvas');
				canvas.width  = img.width;
				canvas.height = img.height;
				const ctx = canvas.getContext('2d');
				ctx.drawImage(img, 0, 0);
				resolve(ctx.getImageData(0, 0, img.width, img.height));
			};
			img.onerror = () => reject(new Error('Failed to decode server image'));
			img.src = dataUrl;
		});
	}

	// Write an ImageData back into a layer's link image and trigger a re-render.
	set_layer_from_image_data(layer, imageData) {
		const canvas = document.createElement('canvas');
		canvas.width  = imageData.width;
		canvas.height = imageData.height;
		canvas.getContext('2d').putImageData(imageData, 0, 0);
		const img = new Image();
		img.onload = () => {
			layer.link   = img;
			layer.width  = img.width;
			layer.height = img.height;
			config.need_render = true;
			app.GUI.GUI_layers.render_layers();
		};
		img.src = canvas.toDataURL('image/png');
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
				'',
				`Submit ${changedPixels.toLocaleString()} changed pixel(s) for ${totalCost} tokens?`,
				() => { this.do_submit(); },
				() => {}
			);
		} catch (e) {
			alertify.error('Failed to prepare submission: ' + e.message);
			console.error(e);
		}
	}

	show_spinner() {
		const overlay = document.createElement('div');
		overlay.id = 'submit-spinner-overlay';
		overlay.innerHTML = '<div class="submit-spinner"></div>';
		document.body.appendChild(overlay);
	}

	hide_spinner() {
		const overlay = document.getElementById('submit-spinner-overlay');
		if (overlay) overlay.remove();
	}

	async do_submit() {
		this.show_spinner();
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
				console.error('Submission failed', {
					url:          `${this.api_url}/MemePlaces/submissions/submit`,
					status:       resp.status,
					statusText:   resp.statusText,
					responseBody: text,
					file: {
						name: filename,
						sizeBytes: blob.size,
						type: blob.type,
					},
					placeId:    this.place_id,
					canvas:     `${config.WIDTH}x${config.HEIGHT}`,
					hasToken:   !!localStorage.getItem(LS_ACCESS_TOKEN),
				});
				throw new Error(`HTTP ${resp.status}: ${text}`);
			}

			const result = await resp.json();
			alertify.success(`Submitted! ${result.pixelChangeCount.toLocaleString()} pixels changed.`);
			setTimeout(() => this.load_place_image(), 3000);
		} catch (e) {
			alertify.error('Submission failed: ' + e.message);
			console.error(e);
		} finally {
			this.hide_spinner();
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
