// Drives Safari with VoiceOver over calendar-voiceover-test.html and records
// every phrase VoiceOver speaks per step. Based on the probe that ran on a
// MacBook (Safari 17.6, Guidepup 0.40.0); adapted for a CI runner.
//
// Copies on the page, in order: A (develop), B (with ARIA table roles),
// C (control: native table display, must pass), D (control:
// role="presentation", must not be found as a table).
import * as guidepup from '@guidepup/guidepup';
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { voiceOver } = guidepup;
const here = dirname( fileURLToPath( import.meta.url ) );
const outDir = join( here, 'results' );
const sleep = ( ms ) => new Promise( ( r ) => setTimeout( r, ms ) );

mkdirSync( outDir, { recursive: true } );

// Serve the page over http. On a runner, Safari stops a file:// URL at a
// "Confirm the file to load." prompt. Other requests (the font files) get 404.
const html = readFileSync( join( here, 'calendar-voiceover-test.html' ) );
let served = false;
const server = createServer( ( req, res ) => {
	if ( req.url.startsWith( '/calendar-voiceover-test.html' ) ) {
		served = true;
		res.writeHead( 200, { 'Content-Type': 'text/html; charset=utf-8' } );
		res.end( html );
	} else {
		res.writeHead( 404 );
		res.end();
	}
} );
await new Promise( ( r ) => server.listen( 0, '127.0.0.1', r ) );
const pageUrl = `http://127.0.0.1:${ server.address().port }/calendar-voiceover-test.html`;

const sh = ( cmd ) => {
	try {
		return execSync( cmd ).toString().trim();
	} catch ( e ) {
		return `unavailable: ${ e.message.split( '\n' )[ 0 ] }`;
	}
};

const versions = {
	macOS: sh( 'sw_vers -productVersion' ),
	macOSBuild: sh( 'sw_vers -buildVersion' ),
	safari: sh( 'defaults read /Applications/Safari.app/Contents/Info CFBundleShortVersionString' ),
	webKitBuild: sh( 'defaults read /Applications/Safari.app/Contents/Info CFBundleVersion' ),
	voiceOver: sh(
		'defaults read /System/Library/CoreServices/VoiceOver.app/Contents/Info CFBundleShortVersionString'
	),
	guidepup: sh( 'node -p "require(\'@guidepup/guidepup/package.json\').version"' ),
	node: process.version,
};

let seen = 0;

// Runs one step and returns every phrase spoken since the previous step.
async function step( name ) {
	if ( 'top' === name ) {
		await voiceOver.press( 'Control+Option+Home' );
	} else {
		await voiceOver.perform( voiceOver.keyboardCommands[ name ] );
	}
	await sleep( 2000 );
	const all = await voiceOver.spokenPhraseLog();
	const spoken = all.slice( seen );
	seen = all.length;
	return { key: name, spoken };
}

// Name of the app in front. Without this, a run where Finder kept focus
// (macOS 26) looked like a run with no tables.
const frontApp = () => sh( 'lsappinfo info -only name "$(lsappinfo front)"' );
const screenshot = ( name ) => sh( `screencapture -x "${ join( outDir, `${ name }.png` ) }"` );

// Puts the VoiceOver cursor at the top of the page. VO-Home lands in one of
// three places, and not always the same one on a given macOS: the page's
// first heading, the "web content" item, or Safari's toolbar (seen on macOS
// 14), where find-next-table finds nothing. From the toolbar, move to "web
// content"; from "web content", interact with it. Moving any further can pass
// table A.
async function enterPage() {
	const steps = [ await step( 'top' ) ];
	const last = () => steps.at( -1 ).spoken.join( ' ' );
	if ( /toolbar/i.test( last() ) ) {
		for ( let i = 0; i < 6 && ! /web content/i.test( last() ); i++ ) {
			steps.push( await step( 'moveToNext' ) );
		}
	}
	if ( /web content/i.test( last() ) ) {
		steps.push( await step( 'interactWithItem' ) );
	}
	return steps;
}

// The tables on the page, in order, by the label that starts each caption.
// Find-next-table must reach every one. It must never reach month copy D
// (role="presentation"), which sits between month C and Week A.
const views = [ 'Week', 'Week grid', 'Day', 'Day grid' ];
const expected = [ 'A', 'B', 'C', ...views.flatMap( ( v ) => [ 'A', 'B', 'C' ].map( ( k ) => `${ v } ${ k }` ) ) ];
const labelPattern = /\b(Week grid [ABC]|Week [ABC]|Day grid [ABC]|Day [ABC]|[A-D]): /;
const labelOf = ( spoken ) => spoken.join( ' ' ).match( labelPattern )?.[ 1 ] ?? null;

// Run on each month table after find-next-table lands on it.
const monthWalk = [
	'interactWithItem',
	'moveDown', // Row 2 (Week 44).
	'moveDown', // Row 3 (Week 45).
	'moveToNext', // Mon 2.
	'moveDown', // Mon 9: announces Week 46?
	'readTableRowAndColumnNumbers',
	'moveToNext', // Tue 10.
	'moveDown', // Tue 17: announces Week 47?
	'readTableRow',
	'readTableRowAndColumnNumbers',
	'stopInteractingWithItem',
];

// Run on each week and day view table. Cells hold events, so a move to the
// next item can land on an event link inside the cell; each move is followed
// by a position read.
const viewWalk = [
	'interactWithItem', // Row 1, column 1.
	'moveDown', // Row 2: the first week, or the day's cell.
	'readTableRowAndColumnNumbers',
	'moveToNext',
	'readTableRowAndColumnNumbers',
	'moveToNext',
	'readTableRowAndColumnNumbers',
	'moveDown', // Row 3 in the week views: announces the next week?
	'readTableRowAndColumnNumbers',
	'readTableRow',
	'stopInteractingWithItem',
];

const out = { versions, pageUrl, finds: [], walks: {} };
let stopRecording = null;

try {
	// The runner was set up with --macos-record, so a screen recording is allowed.
	if ( 'function' === typeof guidepup.macOSRecord ) {
		stopRecording = guidepup.macOSRecord( join( outDir, 'recording.mov' ) );
	}

	// VoiceOver sometimes fails to start on a fresh runner ("VoiceOver cannot
	// be started"), so try up to three times.
	for ( let attempt = 1; ; attempt++ ) {
		try {
			await voiceOver.start();
			break;
		} catch ( e ) {
			if ( attempt >= 3 ) {
				throw e;
			}
			try {
				await voiceOver.stop();
			} catch {}
			await sleep( 5000 );
		}
	}
	await sleep( 2000 );
	seen = ( await voiceOver.spokenPhraseLog() ).length;

	// `open -a` loads the URL and brings Safari to the front. Wait until the
	// page was served, then give Safari time to render it.
	execSync( `open -a Safari "${ pageUrl }"` );
	for ( let i = 0; i < 60 && ! served; i++ ) {
		await sleep( 500 );
	}
	await sleep( 4000 );
	out.front = frontApp();
	screenshot( 'page-loaded' );
	out.enter = await enterPage();

	// One pass, no reloads: find a table, walk it, step past it, find the
	// next. A table that is not found is never walked, and shows as missing.
	const walked = [];
	for ( let tries = 0; tries < 30 && walked.length < expected.length; tries++ ) {
		const find = await step( 'findNextTable' );
		out.finds.push( find );
		const label = labelOf( find.spoken );
		if ( ! label || 'D' === label || walked.includes( label ) ) {
			// "Last table", D, or a table already walked: VoiceOver kept the
			// cursor where it was. Step forward and find again.
			out.finds.push( await step( 'moveToNext' ) );
			continue;
		}
		const steps = [ find ];
		for ( const k of 1 === label.length ? monthWalk : viewWalk ) {
			steps.push( await step( k ) );
		}
		// On macOS 14 and 26, a find straight after "Out of table" sometimes
		// said "Last table" and stayed in the table. Step past it first.
		steps.push( await step( 'moveToNext' ) );
		out.walks[ label ] = steps;
		walked.push( label );
	}
	out.finds.push( await step( 'findNextTable' ) );
	out.finds.push( await step( 'findNextTable' ) );
	screenshot( 'page-end' );

	// A quick reading for the job log. The JSON is the evidence.
	const finds = out.finds.filter( ( f ) => 'findNextTable' === f.key );
	const tables = {};
	for ( const label of expected ) {
		const find = finds.find( ( f ) => labelOf( f.spoken ) === label )?.spoken.join( ' ' ) ?? '';
		const size = find.match( /(\d+) columns?, (\d+) rows?/ );
		const enter = out.walks[ label ]?.[ 1 ].spoken.join( ' ' ) ?? '';
		tables[ label ] = {
			found: Boolean( find ),
			columns: size ? Number( size[ 1 ] ) : null,
			rows: size ? Number( size[ 2 ] ) : null,
			entered: enter.startsWith( `In ${ label }: ` ),
		};
	}
	const foundD = finds.some( ( f ) => 'D' === labelOf( f.spoken ) );
	out.summary = {
		tables,
		foundD,
		missing: expected.filter( ( l ) => ! tables[ l ].found ),
		// The controls prove the harness works. If month C is not found and
		// entered, or D is found, the other results mean nothing.
		controlsPass: tables.C.found && tables.C.entered && ! foundD,
	};
	if ( ! out.summary.controlsPass ) {
		process.exitCode = 1;
	}
} catch ( e ) {
	out.error = String( e?.stack || e );
	process.exitCode = 1;
} finally {
	try {
		await voiceOver.stop();
	} catch {}
	if ( stopRecording ) {
		stopRecording();
	}
	server.close();
	writeFileSync( join( outDir, 'voiceover-probe.json' ), JSON.stringify( out, null, 2 ) );
	console.log( JSON.stringify( { versions, front: out.front, summary: out.summary, error: out.error }, null, 1 ) );
}
