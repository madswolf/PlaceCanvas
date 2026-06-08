import app from './../../app.js';
import config from './../../config.js';
import Base_layers_class from './../../core/base-layers.js';
import alertify from './../../../../node_modules/alertifyjs/build/alertify.min.js';

var instance = null;

class Place_integration_class {
	constructor() {
		if (instance) return instance;
		instance = this;

		this.Base_layers = new Base_layers_class();
		this.api_url = null;
		this.place_id = null;
		this.auth_token = null;
		this.base_layer_id = null;
		this.filename = null;
		this.refetch_interval_id = null;
	}

	init() {
		const params = new URLSearchParams(window.location.search);

		this.api_url = params.get('apiUrl') || localStorage.getItem('pc_api_url');
		this.place_id = params.get('placeId') || localStorage.getItem('pc_place_id');
		this.auth_token = params.get('token') || localStorage.getItem('pc_auth_token');

		if (this.api_url) this.api_url = this.api_url.replace(/\/$/, '');

		if (params.get('apiUrl')) localStorage.setItem('pc_api_url', this.api_url);
		if (params.get('placeId')) localStorage.setItem('pc_place_id', this.place_id);
		if (params.get('token')) localStorage.setItem('pc_auth_token', this.auth_token);

		this.add_submit_button();

		if (this.api_url && this.place_id) {
			this.load_place_image();
			this.start_periodic_refetch(30000);
		} else {
			alertify.message('Add ?apiUrl=...&placeId=... to the URL to load the place image.');
		}
	}

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

	async load_place_image() {
		if (!this.api_url || !this.place_id) return;

		try {
			const subResp = await fetch(`${this.api_url}/MemePlaces/${this.place_id}/submissions/latest`);
			if (subResp.status === 204) {
				// No submissions yet - load an empty canvas sized to the place
				return;
			}
			if (!subResp.ok) throw new Error(`HTTP ${subResp.status}`);
			const submission = await subResp.json();

			const imgResp = await fetch(`${this.api_url}/MemePlaces/submissions/${submission.id}`);
			if (!imgResp.ok) throw new Error(`HTTP ${imgResp.status}`);

			const imgBuffer = await imgResp.arrayBuffer();
			this.filename = this.read_exif_filename(imgBuffer) || 'place_submission';

			const blob = new Blob([imgBuffer]);
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

		// config.layer is now the newly inserted place image layer
		const baseLayer = config.layer;
		this.base_layer_id = baseLayer.id;
		baseLayer.locked = true;

		// Push it to the lowest z-order so it stays underneath everything
		const minOrder = Math.min(...config.layers.map(l => l.order));
		baseLayer.order = minOrder - 1;

		// Add an empty paint layer above the base for the user to draw on
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

	blob_to_data_url(blob) {
		return new Promise(resolve => {
			const reader = new FileReader();
			reader.onload = e => resolve(e.target.result);
			reader.readAsDataURL(blob);
		});
	}

	start_periodic_refetch(intervalMs) {
		if (this.refetch_interval_id) clearInterval(this.refetch_interval_id);
		this.refetch_interval_id = setInterval(() => this.load_place_image(), intervalMs);
	}

	async get_pixel_price() {
		const resp = await fetch(`${this.api_url}/MemePlaces/${this.place_id}/currentprice`);
		if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
		return resp.json();
	}

	calculate_pixel_changes() {
		if (this.base_layer_id === null) return 0;

		const fullCanvas = document.createElement('canvas');
		fullCanvas.width = config.WIDTH;
		fullCanvas.height = config.HEIGHT;
		const fullCtx = fullCanvas.getContext('2d');
		app.Layers.convert_layers_to_canvas(fullCtx);

		const baseCanvas = document.createElement('canvas');
		baseCanvas.width = config.WIDTH;
		baseCanvas.height = config.HEIGHT;
		const baseCtx = baseCanvas.getContext('2d');
		app.Layers.convert_layers_to_canvas(baseCtx, this.base_layer_id);

		const fullData = fullCtx.getImageData(0, 0, config.WIDTH, config.HEIGHT).data;
		const baseData = baseCtx.getImageData(0, 0, config.WIDTH, config.HEIGHT).data;

		let changed = 0;
		for (let i = 0; i < fullData.length; i += 4) {
			if (fullData[i] !== baseData[i] ||
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

		if (!this.auth_token) {
			alertify.prompt('Enter your auth token:', '', (evt, value) => {
				if (value) {
					this.auth_token = value.trim();
					localStorage.setItem('pc_auth_token', this.auth_token);
					this.submit();
				}
			}, () => {});
			return;
		}

		try {
			const priceData = await this.get_pixel_price();
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
			exportCanvas.width = config.WIDTH;
			exportCanvas.height = config.HEIGHT;
			const exportCtx = exportCanvas.getContext('2d');
			app.Layers.convert_layers_to_canvas(exportCtx);

			const blob = await new Promise(resolve => exportCanvas.toBlob(resolve, 'image/png'));
			const safeName = (this.filename || 'place_submission').replace(/\0/g, '').trim();
			const filename = safeName.endsWith('.png') ? safeName : safeName + '.png';

			const formData = new FormData();
			formData.append('ImageWithChanges', blob, filename);
			formData.append('PlaceId', this.place_id);

			const resp = await fetch(`${this.api_url}/MemePlaces/submissions/submit`, {
				method: 'POST',
				headers: { 'Authorization': `Bearer ${this.auth_token}` },
				body: formData,
			});

			if (!resp.ok) {
				if (resp.status === 401) {
					localStorage.removeItem('pc_auth_token');
					this.auth_token = null;
					throw new Error('Unauthorized - your token may have expired');
				}
				const text = await resp.text();
				throw new Error(`HTTP ${resp.status}: ${text}`);
			}

			const result = await resp.json();
			alertify.success(`Submitted! ${result.pixelChangeCount.toLocaleString()} pixels changed.`);

			// Refresh base layer after a short delay to let the server rerender
			setTimeout(() => this.load_place_image(), 3000);
		} catch (e) {
			alertify.error('Submission failed: ' + e.message);
			console.error(e);
		}
	}

	// ── EXIF UserComment reader ────────────────────────────────────────────────

	read_exif_filename(arrayBuffer) {
		try {
			const bytes = new Uint8Array(arrayBuffer);
			const view = new DataView(arrayBuffer);
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
				// Check for "Exif\0\0" header
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
		const ifd0Start = tiffStart + ifd0Offset;

		let comment = this.scan_ifd_for_comment(view, bytes, tiffStart, ifd0Start, le);
		if (comment !== null) return comment;

		// Check EXIF SubIFD (tag 0x8769)
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
				const valStart = byteCount > 4
					? tiffStart + view.getUint32(off + 8, le)
					: off + 8;

				// First 8 bytes = encoding identifier (e.g. "UNICODE\0" or "ASCII\0\0\0")
				const charset = new TextDecoder('ascii')
					.decode(bytes.slice(valStart, valStart + 8))
					.replace(/\0/g, '')
					.trim();

				const data = bytes.slice(valStart + 8, valStart + byteCount);
				let text;
				if (charset === 'UNICODE') {
					text = new TextDecoder('utf-16le').decode(data);
				} else {
					text = new TextDecoder('utf-8').decode(data);
				}
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
