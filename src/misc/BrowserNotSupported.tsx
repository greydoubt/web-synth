import { ANewTab } from 'ameo-utils/dist/util/react';
import React from 'react';
import { createRoot } from 'react-dom/client';

import './BrowserNotSupported.scss';
import 'src/index.scss';

const BrowserNotSupported: React.FC<{ mobileSupported?: boolean }> = ({
  mobileSupported = false,
}) => (
  <div className='browser-not-supported'>
    <h1>Your Browser Isn&apos;t Supported</h1>

    <p>
      Your current browser isn&apos;t supported by this application. It makes use of modern Web
      Audio APIs su ch as{' '}
      <ANewTab to='https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletNode'>
        <code>AudioWorkletNode</code>
      </ANewTab>{' '}
      for many of its internal components, and your browser doesn&apos;t support it. Both Chrome and
      Firefox support this on both mobile and desktop.{' '}
      {mobileSupported
        ? 'If you are on mobile and viewing the site from an embedded browser from an app like Twitter or Reddit, try visiting again from the standalone browser application.'
        : null}
    </p>
    <p>
      If you are using a browser that supports these features and are still seeing this message, you
      may need to update to the latest version.
    </p>
    <br />
  </div>
);

export const createBrowserNotSupportedMessage = () => {
  const body = document.getElementsByTagName('body')[0];
  while (body.children.length > 0) {
    body.children[0].remove();
  }

  createRoot(body).render(<BrowserNotSupported />);
};

export default BrowserNotSupported;
