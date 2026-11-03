// Drives Safari with VoiceOver over calendar-voiceover-test.html and records
// every phrase VoiceOver speaks per step. Based on the probe that ran on a
// MacBook (Safari 17.6, Guidepup 0.40.0); adapted for a CI runner.
//
// Copies on the page, in order: A (develop), B (with ARIA table roles),
// C (control: native table display, must pass), D (control:
// role="presentation", must not be found as a table).
import * as guidepup from '@guidepup/guidepup';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { voiceOver } = guidepup;
const here = dirname( fileURLToPath( import.meta.url ) );
const pageUrl = pathToFileURL( join( here, 'calendar-voiceover-test.html' ) ).href;
const outDir = join( here, 'results' );
const sleep = ( ms ) => new Promise( ( r ) => setTimeout( r, ms ) );

mkdirSync( outDir, { recursive: true } );

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

async function openPage() {
	execSync(
		`osascript -e 'tell application "Safari"' -e 'activate' ` +
			`-e 'if (count of windows) is 0 then make new document' ` +
			`-e 'set URL of front document to "${ pageUrl }"' -e 'end tell'`
	);
	await sleep( 5000 );
	return step( 'top' );
}

const out = { versions, finds: [], walks: {} };
let stopRecording = null;

try {
	// The runner was set up with --macos-record, so a screen recording is allowed.
	if ( 'function' === typeof guidepup.macOSRecord ) {
		stopRecording = guidepup.macOSRecord( join( outDir, 'recording.mov' ) );
	}

	await voiceOver.start();
	await sleep( 2000 );
	seen = ( await voiceOver.spokenPhraseLog() ).length;

	out.finds.push( await openPage() );
	for ( let i = 0; i < 5; i++ ) {
		out.finds.push( await step( 'findNextTable' ) );
	}

	for ( let n = 1; n <= 3; n++ ) {
		const steps = [ await openPage() ];
		for ( let i = 0; i < n; i++ ) {
			steps.push( await step( 'findNextTable' ) );
		}
		for ( const k of [
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
		] ) {
			steps.push( await step( k ) );
		}
		out.walks[ `table ${ n }` ] = steps;
	}

	// A quick reading for the job log. The JSON is the evidence.
	const found = out.finds.flatMap( ( f ) => f.spoken ).join( ' | ' );
	out.summary = {
		foundA: /\bA: November 2026 table\b/.test( found ),
		foundB: /\bB: November 2026 table\b/.test( found ),
		foundC: /\bC: November 2026 table\b/.test( found ),
		foundD: /\bD: November 2026\b/.test( found ),
	};
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
	writeFileSync( join( outDir, 'voiceover-probe.json' ), JSON.stringify( out, null, 2 ) );
	console.log( JSON.stringify( out, null, 1 ) );
}
