import { clock12, linkHost, num, storeName } from './supplementsView';

describe('supplementsView helpers', () => {
  it('writes a 24-hour time the way the page shows it', () => {
    expect(clock12('16:30')).toBe('4:30 PM');
    expect(clock12('15:00')).toBe('3:00 PM');
    expect(clock12('00:05')).toBe('12:05 AM');
    expect(clock12('12:00')).toBe('12:00 PM');
  });

  it('formats amounts to one decimal with separators', () => {
    expect(num(387.5)).toBe('387.5');
    expect(num(3400)).toBe('3,400');
    expect(num(24)).toBe('24');
  });

  it('reads a link’s host, and nothing from a non-web link', () => {
    expect(linkHost('https://www.amazon.com/dp/x')).toBe('amazon.com');
    expect(linkHost('javascript:alert(1)')).toBeUndefined();
    expect(linkHost('not a url')).toBeUndefined();
  });

  it('names a store from its host', () => {
    expect(storeName('amazon.com')).toBe('Amazon');
    expect(storeName('thorne.com')).toBe('Thorne');
    expect(storeName('example.co.uk')).toBe('Example');
  });
});
