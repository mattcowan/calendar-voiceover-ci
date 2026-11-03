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

// Puts the VoiceOver cursor inside the page. On macOS 14, VO-Home lands on
// Safari's toolbar, and find-next-table from there finds nothing. So move
// to the "web content" item and interact with it.
async function enterPage() {
	const steps = [ await step( 'top' ) ];
	const onWebContent = () => /web content/i.test( steps.at( -1 ).spoken.join( ' ' ) );
	for ( let i = 0; i < 6 && ! onWebContent(); i++ ) {
		steps.push( await step( 'moveToNext' ) );
	}
	steps.push( await step( 'interactWithItem' ) );
	return steps;
}

// Run on each table after find-next-table lands on it.
const walk = [
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

const out = { versions, pageUrl, finds: [], walks: {} };
let stopRecording = null;

try {
	// The runner was set up with --macos-record, so a screen recording is allowed.
	if ( 'function' === typeof guidepup.macOSRecord ) {
		stopRecording = guidepup.macOSRecord( join( outDir, 'recording.mov' ) );
	}

	await voiceOver.start();
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

	// One pass, no reloads: find a table, walk it, stop interacting, find the
	// next. After C, two more finds must not reach D.
	for ( let n = 1; n <= 3; n++ ) {
		const steps = [ await step( 'findNextTable' ) ];
		out.finds.push( steps[ 0 ] );
		for ( const k of walk ) {
			steps.push( await step( k ) );
		}
		out.walks[ `table ${ n }` ] = steps;
	}
	out.finds.push( await step( 'findNextTable' ) );
	out.finds.push( await step( 'findNextTable' ) );
	screenshot( 'page-end' );

	// A quick reading for the job log. The JSON is the evidence.
	const found = out.finds.flatMap( ( f ) => f.spoken ).join( ' | ' );
	const walked = Object.values( out.walks )
		.map( ( s ) => s[ 1 ].spoken.join( ' ' ).match( /\bIn ([A-D]): November 2026 table\b/ )?.[ 1 ] ?? '-' )
		.join( '' );
	out.summary = {
		foundA: /\bA: November 2026 table\b/.test( found ),
		foundB: /\bB: November 2026 table\b/.test( found ),
		foundC: /\bC: November 2026 table\b/.test( found ),
		foundD: /\bD: November 2026\b/.test( found ),
		walked, // Table entered by each walk; "ABC" when all three were found.
	};

	// The controls prove the harness works. If C is not found or walked, or D
	// is found, the A and B results mean nothing, so fail the job.
	out.summary.controlsPass =
		out.summary.foundC && walked.includes( 'C' ) && ! out.summary.foundD;
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
	console.log( JSON.stringify( out, null, 1 ) );
}
